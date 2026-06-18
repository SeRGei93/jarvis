import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { runSeed } from "../../src/db/seed.js";
import { SettingsService } from "../../src/config/settings.js";
import { UsageService } from "../../src/services/usage.js";
import { RateLimitService } from "../../src/services/rate-limit.js";
import { AccessRequestService } from "../../src/services/access-request-service.js";
import { usersRoutes } from "../../src/admin/api/users.js";
import type { AdminApiDeps } from "../../src/admin/api/deps.js";
import type { AdminEnv } from "../../src/admin/api/deps.js";
import {
  users,
  userChannels,
  subscriptionPlans,
  userSubscriptions,
  accessRequests,
} from "../../src/db/schema.js";

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

/** Build a Hono app with injected deps that bypasses the admin auth gate. */
function makeApp(db: TestDb["db"]) {
  const settings = new SettingsService(db);
  const usage = new UsageService(db);
  const rateLimit = new RateLimitService(db);
  const accessReqs = new AccessRequestService(db, settings);
  const notified: { tgUserId: number; text: string }[] = [];
  const notify = async (tgUserId: number, text: string) => {
    notified.push({ tgUserId, text });
  };
  const deps = {
    db,
    settings,
    usage,
    rateLimit,
    accessRequests: accessReqs,
    notify,
  } as unknown as AdminApiDeps;
  const app = new Hono<AdminEnv>();
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    c.set("adminUserId", 1);
    await next();
  });
  app.route("/", usersRoutes());
  return { app, settings, accessRequests: accessReqs, notified };
}

async function seedUser(db: TestDb["db"], over: Partial<typeof users.$inferInsert> = {}) {
  const [u] = await db
    .insert(users)
    .values({ name: "u", displayName: "Ada", city: "Minsk", ...over })
    .returning({ id: users.id });
  return u!.id;
}

describe("usersRoutes", () => {
  it("lists users joined with channels and current plan", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    const userId = await seedUser(t.db);
    await t.db.insert(userChannels).values({ userId, provider: "telegram", externalId: "9001" });
    const [plan] = await t.db
      .select({ id: subscriptionPlans.id })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.name, "pro"));
    await t.db.insert(userSubscriptions).values({ userId, planId: plan!.id });

    const { app } = makeApp(t.db);
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: any[] };
    expect(body.users).toHaveLength(1);
    const u = body.users[0];
    expect(u.id).toBe(userId);
    expect(u.displayName).toBe("Ada");
    expect(u.channels).toEqual([
      expect.objectContaining({ provider: "telegram", externalId: "9001" }),
    ]);
    expect(u.plan).toMatchObject({ name: "pro" });
  });

  it("GET /:id returns the user (404 when missing)", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    const userId = await seedUser(t.db);

    const { app } = makeApp(t.db);
    const ok = await app.request(`/${userId}`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).id).toBe(userId);

    const missing = await app.request("/999999");
    expect(missing.status).toBe(404);
  });

  it("PATCH /:id updates only the supplied fields", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    const userId = await seedUser(t.db, { onboarded: false });

    const { app } = makeApp(t.db);
    const res = await app.request(`/${userId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ city: "Berlin", onboarded: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.city).toBe("Berlin");
    expect(body.onboarded).toBe(true);
    expect(body.displayName).toBe("Ada"); // untouched

    const [row] = await t.db.select().from(users).where(eq(users.id, userId));
    expect(row!.city).toBe("Berlin");
    expect(row!.onboarded).toBe(true);
  });

  it("PATCH /:id rejects an invalid body (400)", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    const userId = await seedUser(t.db);

    const { app } = makeApp(t.db);
    const res = await app.request(`/${userId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ onboarded: "yes" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET/PUT /allowlist round-trips through SettingsService", async () => {
    t = await createTestDb();
    await runSeed(t.db);

    const { app, settings } = makeApp(t.db);
    const before = await app.request("/allowlist");
    expect(before.status).toBe(200);
    expect(((await before.json()) as any).userIds).toEqual([]);

    const put = await app.request("/allowlist", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userIds: [10, 20, 30] }),
    });
    expect(put.status).toBe(200);

    // The setting is persisted and the cache invalidated → service reads it back.
    expect(await settings.getAllowedUsers()).toEqual([10, 20, 30]);

    const after = await app.request("/allowlist");
    expect(((await after.json()) as any).userIds).toEqual([10, 20, 30]);
  });

  it("PUT /allowlist rejects a non-numeric list (400)", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    const { app } = makeApp(t.db);
    const res = await app.request("/allowlist", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userIds: ["x"] }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /allowlist defaults mode to 'open'; PUT /access-mode round-trips", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    const { app, settings } = makeApp(t.db);

    const before = await app.request("/allowlist");
    expect(((await before.json()) as any).mode).toBe("open");

    const put = await app.request("/access-mode", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "approval" }),
    });
    expect(put.status).toBe(200);
    expect(await settings.getAccessMode()).toBe("approval");

    const after = await app.request("/allowlist");
    expect(((await after.json()) as any).mode).toBe("approval");
  });

  it("PUT /access-mode rejects an unknown mode (400)", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    const { app } = makeApp(t.db);
    const res = await app.request("/access-mode", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "nonsense" }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /requests lists pending; approve adds to allowlist + notifies", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    await t.db.insert(accessRequests).values({ tgUserId: 555, name: "Bob", username: "bob" });

    const { app, settings, notified } = makeApp(t.db);

    const list = await app.request("/requests");
    expect(list.status).toBe(200);
    const body = (await list.json()) as { requests: any[] };
    expect(body.requests).toHaveLength(1);
    const reqId = body.requests[0].id;
    expect(body.requests[0]).toMatchObject({ tgUserId: 555, name: "Bob", username: "bob" });

    const approve = await app.request(`/requests/${reqId}/approve`, { method: "POST" });
    expect(approve.status).toBe(200);
    expect(await settings.getAllowedUsers()).toContain(555);
    expect(notified).toEqual([{ tgUserId: 555, text: expect.stringContaining("Доступ открыт") }]);

    // No longer pending.
    const after = (await (await app.request("/requests")).json()) as { requests: any[] };
    expect(after.requests).toHaveLength(0);
  });

  it("POST /requests/:id/reject marks rejected; re-deciding is 404", async () => {
    t = await createTestDb();
    await runSeed(t.db);
    await t.db.insert(accessRequests).values({ tgUserId: 777, name: "Eve" });
    const { app, settings } = makeApp(t.db);
    const reqId = ((await (await app.request("/requests")).json()) as { requests: any[] }).requests[0].id;

    const reject = await app.request(`/requests/${reqId}/reject`, { method: "POST" });
    expect(reject.status).toBe(200);
    expect(await settings.getAllowedUsers()).not.toContain(777);

    // Already decided → approve now 404s.
    const approveAgain = await app.request(`/requests/${reqId}/approve`, { method: "POST" });
    expect(approveAgain.status).toBe(404);
  });
});

