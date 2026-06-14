import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { runSeed } from "../../src/db/seed.js";
import { SettingsService } from "../../src/config/settings.js";
import { UsageService } from "../../src/services/usage.js";
import { RateLimitService } from "../../src/services/rate-limit.js";
import { usageRoutes } from "../../src/admin/api/usage.js";
import type { AdminApiDeps, AdminEnv } from "../../src/admin/api/deps.js";
import { users, subscriptionPlans, userSubscriptions, messageRateLimits } from "../../src/db/schema.js";

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

function makeApp(db: TestDb["db"]) {
  const settings = new SettingsService(db);
  const usage = new UsageService(db);
  const rateLimit = new RateLimitService(db);
  const deps = { db, settings, usage, rateLimit } as unknown as AdminApiDeps;
  const app = new Hono<AdminEnv>();
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    c.set("adminUserId", 1);
    await next();
  });
  app.route("/", usageRoutes());
  return { app, usage, rateLimit };
}

async function seedUser(db: TestDb["db"]) {
  const [u] = await db.insert(users).values({ onboarded: true }).returning({ id: users.id });
  return u!.id;
}

describe("usageRoutes", () => {
  it("GET /user/:id returns today's totals, and a period sum with ?since", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    const userId = await seedUser(t.db);
    const { app, usage } = makeApp(t.db);

    await usage.recordUsage(userId, 1.5, 1, "2026-06-10");
    await usage.recordUsage(userId, 2.5, 3, "2026-06-12");

    // No ?since → today's row (none recorded today) → zeros.
    const today = await app.request(`/user/${userId}`);
    expect(today.status).toBe(200);
    expect(await today.json()).toMatchObject({ userId, cost: 0, requests: 0 });

    // ?since spanning both rows → aggregate.
    const since = await app.request(`/user/${userId}?since=2026-06-01`);
    expect(since.status).toBe(200);
    expect(await since.json()).toMatchObject({ userId, cost: 4, requests: 4, since: "2026-06-01" });

    // ?since excluding the earlier row.
    const partial = await app.request(`/user/${userId}?since=2026-06-11`);
    expect(await partial.json()).toMatchObject({ cost: 2.5, requests: 3 });
  });

  it("GET /user/:id rejects a malformed since (400)", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    const userId = await seedUser(t.db);
    const { app } = makeApp(t.db);
    const res = await app.request(`/user/${userId}?since=2026/06/01`);
    expect(res.status).toBe(400);
  });

  it("GET / aggregates across all users with a grand total", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    const a = await seedUser(t.db);
    const b = await seedUser(t.db);
    const { app, usage } = makeApp(t.db);

    await usage.recordUsage(a, 1, 2, "2026-06-10");
    await usage.recordUsage(a, 3, 1, "2026-06-11");
    await usage.recordUsage(b, 5, 4, "2026-06-11");

    const res = await app.request("/?since=2026-06-01");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: any[]; total: any };
    const byUser = Object.fromEntries(body.users.map((u) => [u.userId, u]));
    expect(byUser[a]).toMatchObject({ cost: 4, requests: 3 });
    expect(byUser[b]).toMatchObject({ cost: 5, requests: 4 });
    expect(body.total).toMatchObject({ cost: 9, requests: 7 });
  });

  it("GET / without ?since aggregates all-time", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    const a = await seedUser(t.db);
    const { app, usage } = makeApp(t.db);
    await usage.recordUsage(a, 2, 1, "2020-01-01");
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).total).toMatchObject({ cost: 2, requests: 1 });
  });

  it("DELETE /ratelimit/:userId clears the user's rate-limit windows", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    const userId = await seedUser(t.db);
    // Subscribe to a low limit so a second message would be rejected.
    const [plan] = await t.db
      .insert(subscriptionPlans)
      .values({ name: "tiny", hourlyLimit: 1, maxTasks: 1 })
      .returning({ id: subscriptionPlans.id });
    await t.db.insert(userSubscriptions).values({ userId, planId: plan!.id });

    const { app, rateLimit } = makeApp(t.db);

    expect((await rateLimit.checkAndConsume(userId)).allowed).toBe(true);
    expect((await rateLimit.checkAndConsume(userId)).allowed).toBe(false); // over limit

    const res = await app.request(`/ratelimit/${userId}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const rows = await t.db
      .select()
      .from(messageRateLimits)
      .where(eq(messageRateLimits.userId, userId));
    expect(rows).toHaveLength(0);

    // Window reset → allowed again.
    expect((await rateLimit.checkAndConsume(userId)).allowed).toBe(true);
  });
});
