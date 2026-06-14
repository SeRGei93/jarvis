import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { runSeed } from "../../src/db/seed.js";
import { SettingsService } from "../../src/config/settings.js";
import { UsageService } from "../../src/services/usage.js";
import { RateLimitService } from "../../src/services/rate-limit.js";
import { plansRoutes } from "../../src/admin/api/plans.js";
import type { AdminApiDeps, AdminEnv } from "../../src/admin/api/deps.js";
import { users, subscriptionPlans, userSubscriptions } from "../../src/db/schema.js";

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
  app.route("/", plansRoutes());
  return { app, rateLimit };
}

async function seedUser(db: TestDb["db"]) {
  const [u] = await db.insert(users).values({ onboarded: true }).returning({ id: users.id });
  return u!.id;
}

describe("plansRoutes", () => {
  it("lists seeded plans", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    const { app } = makeApp(t.db);
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plans: any[] };
    expect(body.plans.map((p) => p.name).sort()).toEqual(["admin", "free", "pro"]);
  });

  it("POST creates a plan and rejects a duplicate name (409)", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    const { app } = makeApp(t.db);

    const created = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "enterprise", hourly_limit: 500, max_tasks: 20 }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as any;
    expect(body).toMatchObject({ name: "enterprise", hourlyLimit: 500, maxTasks: 20 });
    expect(typeof body.id).toBe("number");

    const dupe = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "enterprise", hourly_limit: 1, max_tasks: 1 }),
    });
    expect(dupe.status).toBe(409);
  });

  it("POST rejects a negative limit (400)", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    const { app } = makeApp(t.db);
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bad", hourly_limit: -1, max_tasks: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH updates supplied fields; 404 for a missing plan", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    const [pro] = await t.db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.name, "pro"));
    const { app } = makeApp(t.db);

    const res = await app.request(`/${pro!.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hourly_limit: 77 }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).hourlyLimit).toBe(77);

    const [row] = await t.db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, pro!.id));
    expect(row!.hourlyLimit).toBe(77);
    expect(row!.name).toBe("pro"); // untouched

    const missing = await app.request("/999999", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hourly_limit: 1 }),
    });
    expect(missing.status).toBe(404);
  });

  it("DELETE removes an unreferenced plan but blocks a referenced one (409)", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    const userId = await seedUser(t.db);
    const [free] = await t.db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.name, "free"));
    const [admin] = await t.db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.name, "admin"));
    await t.db.insert(userSubscriptions).values({ userId, planId: free!.id });

    const { app } = makeApp(t.db);

    // 'admin' is unreferenced → deletable.
    const okDel = await app.request(`/${admin!.id}`, { method: "DELETE" });
    expect(okDel.status).toBe(200);
    const remaining = await t.db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, admin!.id));
    expect(remaining).toHaveLength(0);

    // 'free' is referenced by a subscription → blocked.
    const blocked = await app.request(`/${free!.id}`, { method: "DELETE" });
    expect(blocked.status).toBe(409);
  });

  it("PUT /assign attaches the plan so rateLimit.resolveLimit reflects it", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    const userId = await seedUser(t.db);
    const [pro] = await t.db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.name, "pro")); // hourlyLimit 50
    const [free] = await t.db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.name, "free")); // hourlyLimit 15

    const { app, rateLimit } = makeApp(t.db);

    const assignPro = await app.request("/assign", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, planId: pro!.id }),
    });
    expect(assignPro.status).toBe(200);
    // resolveLimit consumes the window, so prove the *limit* via checkAndConsume.
    expect((await rateLimit.checkAndConsume(userId)).limit).toBe(50);

    // Re-assigning (upsert on user_id) replaces the plan.
    const assignFree = await app.request("/assign", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, planId: free!.id }),
    });
    expect(assignFree.status).toBe(200);
    expect((await rateLimit.checkAndConsume(userId)).limit).toBe(15);

    // Only one subscription row exists for the user (upsert, not insert).
    const subs = await t.db
      .select()
      .from(userSubscriptions)
      .where(eq(userSubscriptions.userId, userId));
    expect(subs).toHaveLength(1);
    expect(subs[0]!.planId).toBe(free!.id);
  });

  it("PUT /assign 404s for an unknown plan", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    const userId = await seedUser(t.db);
    const { app } = makeApp(t.db);
    const res = await app.request("/assign", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, planId: 999999 }),
    });
    expect(res.status).toBe(404);
  });
});
