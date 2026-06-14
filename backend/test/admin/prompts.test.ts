import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { promptsRoutes } from "../../src/admin/api/prompts.js";
import type { AdminEnv } from "../../src/admin/api/deps.js";
import type { AdminApiDeps } from "../../src/admin/api/deps.js";
import { SkillService } from "../../src/services/skill-service.js";
import { prompts as promptsTable } from "../../src/db/schema.js";

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

async function seed(db: TestDb["db"]): Promise<void> {
  await db.insert(promptsTable).values([
    { key: "SOUL", body: "soul body" },
    { key: "FORMAT", body: "format body" },
  ]);
}

function makeApp(t: TestDb) {
  const skills = new SkillService(t.db);
  const deps = { db: t.db, skills } as unknown as AdminApiDeps;

  const app = new Hono<AdminEnv>();
  app.use("*", async (c, next) => {
    c.set("deps", deps);
    c.set("adminUserId", 1);
    await next();
  });
  app.route("/", promptsRoutes());
  return { app, skills };
}

describe("promptsRoutes", () => {
  it("lists all prompts", async () => {
    t = await createTestDb();
    await seed(t.db);
    const { app } = makeApp(t);

    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ key: string }>;
    expect(body.map((p) => p.key).sort()).toEqual(["FORMAT", "SOUL"]);
  });

  it("gets one prompt, 404 for unknown", async () => {
    t = await createTestDb();
    await seed(t.db);
    const { app } = makeApp(t);

    const ok = await app.request("/SOUL");
    expect(ok.status).toBe(200);
    expect((await ok.json()).body).toBe("soul body");

    const missing = await app.request("/MISSING");
    expect(missing.status).toBe(404);
  });

  it("updates an existing prompt and invalidates the SkillService cache", async () => {
    t = await createTestDb();
    await seed(t.db);
    const { app, skills } = makeApp(t);
    // Warm the prompt cache to prove invalidate() forces a reload.
    expect(await skills.getPrompt("SOUL")).toBe("soul body");

    const res = await app.request("/SOUL", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "new soul" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).body).toBe("new soul");

    // getPrompt() now reflects the update => cache was invalidated.
    expect(await skills.getPrompt("SOUL")).toBe("new soul");
  });

  it("upserts a not-yet-existing known key (WELCOME)", async () => {
    t = await createTestDb();
    await seed(t.db);
    const { app, skills } = makeApp(t);

    const res = await app.request("/WELCOME", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hello!" }),
    });
    expect(res.status).toBe(200);
    expect(await skills.getPrompt("WELCOME")).toBe("hello!");

    const rows = await t.db.select().from(promptsTable);
    expect(rows.map((r) => r.key).sort()).toEqual(["FORMAT", "SOUL", "WELCOME"]);
  });

  it("400s an unknown prompt key", async () => {
    t = await createTestDb();
    await seed(t.db);
    const { app } = makeApp(t);

    const res = await app.request("/NONSENSE", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s a missing body field", async () => {
    t = await createTestDb();
    await seed(t.db);
    const { app } = makeApp(t);

    const res = await app.request("/SOUL", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
