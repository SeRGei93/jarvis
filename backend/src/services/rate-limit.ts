import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { messageRateLimits, users, userSubscriptions, subscriptionPlans } from "../db/schema.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "rate-limit" });

type Db = LibSQLDatabase<typeof schema>;

/**
 * Fallback hourly message limit used when the user has no subscription AND no
 * plan named 'free' exists in the DB. Mirrors a conservative "free tier" cap.
 */
export const DEFAULT_HOURLY_LIMIT = 30;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
}

/**
 * Hourly sliding-window message rate limit per user (parity with Go
 * rate_limit_service.go / check_rate_limit.go).
 *
 * The window is the start of the current clock hour. Each consumed message
 * upserts+increments the `(userId, windowStart)` counter and compares it to the
 * user's plan `hourly_limit`. A new hour starts a fresh row, so the limit slides
 * forward without any cleanup job.
 *
 * Limit resolution order:
 *   1. The plan attached via `user_subscriptions` → `subscription_plans`.
 *   2. Otherwise the plan named 'free', if one exists.
 *   3. Otherwise {@link DEFAULT_HOURLY_LIMIT}.
 * A resolved `hourly_limit` of 0 means "unlimited" (Go parity:
 * SubscriptionPlan.IsUnlimited) — the window is still consumed but never rejects.
 *
 * Onboarding bypass: a user with `onboarded=false` is always allowed and does
 * NOT consume the window (onboarding messages aren't limited).
 */
export class RateLimitService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Truncate `now` to the start of the hour; upsert+increment the window counter;
   * compare to the user's hourly limit.
   *
   * Onboarding bypass: an un-onboarded user is always allowed and does not consume
   * the window.
   */
  async checkAndConsume(userId: number): Promise<RateLimitResult> {
    const windowStart = this.windowStart();
    const limit = await this.resolveLimit(userId);

    // Onboarding bypass — un-onboarded users are never limited and do not consume.
    const userRow = await this.db
      .select({ onboarded: users.onboarded })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const onboarded = userRow[0]?.onboarded ?? true;
    if (!onboarded) {
      log.debug({ userId, limit }, "onboarding bypass — not consuming window");
      return { allowed: true, remaining: limit, limit };
    }

    const count = await this.consume(userId, windowStart);

    // hourly_limit == 0 means unlimited (Go SubscriptionPlan.IsUnlimited parity).
    const unlimited = limit === 0;
    const allowed = unlimited || count <= limit;
    const remaining = unlimited ? limit : Math.max(0, limit - count);

    log.debug({ userId, windowStart, count, limit, allowed }, "rate limit checked");
    if (!allowed) {
      log.warn({ userId, limit }, "rate limit exceeded");
    }
    return { allowed, remaining, limit };
  }

  /** Start of the clock hour for the injected clock (minutes/sec/ms zeroed). */
  private windowStart(): Date {
    const d = new Date(this.now());
    d.setMinutes(0, 0, 0);
    return d;
  }

  /**
   * Resolve the user's hourly limit: their subscribed plan → the 'free' plan →
   * {@link DEFAULT_HOURLY_LIMIT}.
   */
  private async resolveLimit(userId: number): Promise<number> {
    const subRows = await this.db
      .select({ hourlyLimit: subscriptionPlans.hourlyLimit })
      .from(userSubscriptions)
      .innerJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id))
      .where(eq(userSubscriptions.userId, userId))
      .limit(1);
    if (subRows[0]) return subRows[0].hourlyLimit;

    const freeRows = await this.db
      .select({ hourlyLimit: subscriptionPlans.hourlyLimit })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.name, "free"))
      .limit(1);
    if (freeRows[0]) return freeRows[0].hourlyLimit;

    return DEFAULT_HOURLY_LIMIT;
  }

  /**
   * Upsert the `(userId, windowStart)` counter: insert count=1 or increment an
   * existing row, returning the resulting count.
   */
  private async consume(userId: number, windowStart: Date): Promise<number> {
    const rows = await this.db
      .insert(messageRateLimits)
      .values({ userId, windowStart, count: 1 })
      .onConflictDoUpdate({
        target: [messageRateLimits.userId, messageRateLimits.windowStart],
        set: { count: sql`${messageRateLimits.count} + 1` },
      })
      .returning({ count: messageRateLimits.count });

    if (rows[0]) return rows[0].count;

    // Defensive fallback if RETURNING yields nothing (shouldn't happen on libSQL).
    const read = await this.db
      .select({ count: messageRateLimits.count })
      .from(messageRateLimits)
      .where(and(eq(messageRateLimits.userId, userId), eq(messageRateLimits.windowStart, windowStart)))
      .limit(1);
    return read[0]?.count ?? 1;
  }
}
