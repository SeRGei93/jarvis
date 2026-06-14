import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { RateLimitService, DEFAULT_HOURLY_LIMIT } from "../../src/services/rate-limit.js";
import { users, subscriptionPlans, userSubscriptions } from "../../src/db/schema.js";

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

/** Mutable fake clock the service reads via its injected `now()`. */
function fakeClock(start: Date) {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    set: (d: Date) => {
      current = new Date(d);
    },
    advanceHours: (h: number) => {
      current = new Date(current.getTime() + h * 60 * 60 * 1000);
    },
  };
}

/** Insert a user; returns its generated id. */
async function insertUser(t: TestDb, onboarded: boolean): Promise<number> {
  const rows = await t.db.insert(users).values({ onboarded }).returning({ id: users.id });
  return rows[0]!.id;
}

/** Insert a plan + subscription so the user resolves to `hourlyLimit`. */
async function subscribe(t: TestDb, userId: number, name: string, hourlyLimit: number): Promise<void> {
  const planRows = await t.db
    .insert(subscriptionPlans)
    .values({ name, hourlyLimit })
    .returning({ id: subscriptionPlans.id });
  await t.db.insert(userSubscriptions).values({ userId, planId: planRows[0]!.id });
}

describe("RateLimitService", () => {
  it("rejects the (limit+1)-th call within the same hour and decrements remaining", async () => {
    t = await createTestDb();
    const userId = await insertUser(t, true);
    await subscribe(t, userId, "basic", 3);

    const clock = fakeClock(new Date("2026-06-14T10:17:42.500Z"));
    const svc = new RateLimitService(t.db, clock.now);

    const r1 = await svc.checkAndConsume(userId);
    expect(r1).toEqual({ allowed: true, remaining: 2, limit: 3 });

    const r2 = await svc.checkAndConsume(userId);
    expect(r2).toEqual({ allowed: true, remaining: 1, limit: 3 });

    const r3 = await svc.checkAndConsume(userId);
    expect(r3).toEqual({ allowed: true, remaining: 0, limit: 3 });

    // 4th call within the same hour -> over the limit.
    const r4 = await svc.checkAndConsume(userId);
    expect(r4).toEqual({ allowed: false, remaining: 0, limit: 3 });
  });

  it("resets in the next hour (new window row, allowed again)", async () => {
    t = await createTestDb();
    const userId = await insertUser(t, true);
    await subscribe(t, userId, "basic", 1);

    const clock = fakeClock(new Date("2026-06-14T10:59:00.000Z"));
    const svc = new RateLimitService(t.db, clock.now);

    expect((await svc.checkAndConsume(userId)).allowed).toBe(true);
    // Second call in the same hour exceeds limit=1.
    expect((await svc.checkAndConsume(userId)).allowed).toBe(false);

    // Advance into the next clock hour -> fresh window.
    clock.advanceHours(1);
    const next = await svc.checkAndConsume(userId);
    expect(next).toEqual({ allowed: true, remaining: 0, limit: 1 });
  });

  it("always allows an un-onboarded user without consuming the window", async () => {
    t = await createTestDb();
    const userId = await insertUser(t, false);
    await subscribe(t, userId, "basic", 1);

    const clock = fakeClock(new Date("2026-06-14T10:00:00.000Z"));
    const svc = new RateLimitService(t.db, clock.now);

    // Many calls, all within the same hour, all allowed; window never increments.
    for (let i = 0; i < 5; i++) {
      const r = await svc.checkAndConsume(userId);
      expect(r).toEqual({ allowed: true, remaining: 1, limit: 1 });
    }

    // Flip to onboarded -> the very first consuming call still has a fresh counter,
    // proving the bypass did not consume the window.
    await t.db.update(users).set({ onboarded: true }).where(eq(users.id, userId));
    const first = await svc.checkAndConsume(userId);
    expect(first).toEqual({ allowed: true, remaining: 0, limit: 1 });
    expect((await svc.checkAndConsume(userId)).allowed).toBe(false);
  });

  it("falls back to the 'free' plan limit when the user has no subscription", async () => {
    t = await createTestDb();
    const userId = await insertUser(t, true);
    // 'free' plan exists but the user is NOT subscribed to anything.
    await t.db.insert(subscriptionPlans).values({ name: "free", hourlyLimit: 2 });

    const clock = fakeClock(new Date("2026-06-14T08:30:00.000Z"));
    const svc = new RateLimitService(t.db, clock.now);

    expect((await svc.checkAndConsume(userId)).limit).toBe(2);
    expect((await svc.checkAndConsume(userId)).remaining).toBe(0);
    expect((await svc.checkAndConsume(userId)).allowed).toBe(false);
  });

  it("falls back to DEFAULT_HOURLY_LIMIT when there is no subscription and no 'free' plan", async () => {
    t = await createTestDb();
    const userId = await insertUser(t, true);

    const clock = fakeClock(new Date("2026-06-14T08:30:00.000Z"));
    const svc = new RateLimitService(t.db, clock.now);

    const r = await svc.checkAndConsume(userId);
    expect(r.limit).toBe(DEFAULT_HOURLY_LIMIT);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(DEFAULT_HOURLY_LIMIT - 1);
  });
});
