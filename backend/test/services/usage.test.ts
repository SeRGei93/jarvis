import { describe, it, expect, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { UsageService } from "../../src/services/usage.js";
import { users, usageStats } from "../../src/db/schema.js";

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

/** Insert a users row (FK target) and return its id. */
async function makeUser(db: TestDb["db"]): Promise<number> {
  const [u] = await db.insert(users).values({ name: "tester" }).returning({ id: users.id });
  return u!.id;
}

describe("UsageService", () => {
  it("accumulates two same-day records into a single row", async () => {
    t = await createTestDb();
    const userId = await makeUser(t.db);
    const svc = new UsageService(t.db);
    const date = "2026-06-14";

    await svc.recordUsage(userId, 0.1, 1, date);
    await svc.recordUsage(userId, 0.15, 1, date);

    const rows = await t.db
      .select()
      .from(usageStats)
      .where(and(eq(usageStats.userId, userId), eq(usageStats.date, date)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cost).toBeCloseTo(0.25, 10);
    expect(rows[0]!.requests).toBe(2);
  });

  it("keeps different dates in separate rows", async () => {
    t = await createTestDb();
    const userId = await makeUser(t.db);
    const svc = new UsageService(t.db);

    await svc.recordUsage(userId, 0.2, 1, "2026-06-14");
    await svc.recordUsage(userId, 0.3, 1, "2026-06-15");

    const rows = await t.db.select().from(usageStats).where(eq(usageStats.userId, userId));
    expect(rows).toHaveLength(2);
    expect(await svc.getDailyUsage(userId, "2026-06-14")).toEqual({ cost: 0.2, requests: 1 });
    expect(await svc.getDailyUsage(userId, "2026-06-15")).toEqual({ cost: 0.3, requests: 1 });
  });

  it("treats undefined cost as 0 cost but still counts the request", async () => {
    t = await createTestDb();
    const userId = await makeUser(t.db);
    const svc = new UsageService(t.db);
    const date = "2026-06-14";

    await svc.recordUsage(userId, undefined, 1, date);
    expect(await svc.getDailyUsage(userId, date)).toEqual({ cost: 0, requests: 1 });

    // A subsequent priced call accumulates onto the same row.
    await svc.recordUsage(userId, 0.05, 1, date);
    const after = await svc.getDailyUsage(userId, date);
    expect(after.cost).toBeCloseTo(0.05, 10);
    expect(after.requests).toBe(2);
  });

  it("getDailyUsage returns accumulated values and {0,0} for an unused date", async () => {
    t = await createTestDb();
    const userId = await makeUser(t.db);
    const svc = new UsageService(t.db);

    await svc.recordUsage(userId, 0.4, 1, "2026-06-14");
    await svc.recordUsage(userId, 0.6, 1, "2026-06-14");

    const used = await svc.getDailyUsage(userId, "2026-06-14");
    expect(used.cost).toBeCloseTo(1.0, 10);
    expect(used.requests).toBe(2);

    expect(await svc.getDailyUsage(userId, "2020-01-01")).toEqual({ cost: 0, requests: 0 });
  });
});
