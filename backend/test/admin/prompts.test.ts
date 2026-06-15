import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { promptsRoutes } from "../../src/admin/api/prompts.js";
import type { AdminEnv } from "../../src/admin/api/deps.js";
import type { AdminApiDeps } from "../../src/admin/api/deps.js";
import { tempContent, type ContentFixture } from "../helpers/content.js";

let c: ContentFixture | undefined;
afterEach(() => {
  c?.cleanup();
  c = undefined;
});

function makeApp() {
  c = tempContent({ prompts: { SOUL: "soul body", FORMAT: "format body" } });
  const deps = { skills: c.skills } as unknown as AdminApiDeps;

  const app = new Hono<AdminEnv>();
  app.use("*", async (ctx, next) => {
    ctx.set("deps", deps);
    ctx.set("adminUserId", 1);
    await next();
  });
  app.route("/", promptsRoutes());
  return { app, skills: c.skills };
}

describe("promptsRoutes", () => {
  it("lists all prompts", async () => {
    const { app } = makeApp();

    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ key: string }>;
    expect(body.map((p) => p.key).sort()).toEqual(["FORMAT", "SOUL"]);
  });

  it("gets one prompt, 404 for unknown", async () => {
    const { app } = makeApp();

    const ok = await app.request("/SOUL");
    expect(ok.status).toBe(200);
    expect((await ok.json()).body).toBe("soul body");

    const missing = await app.request("/MISSING");
    expect(missing.status).toBe(404);
  });

  it("updates an existing prompt and invalidates the SkillService cache", async () => {
    const { app, skills } = makeApp();
    // Warm the prompt cache to prove the write forces a reload.
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
    const { app, skills } = makeApp();

    const res = await app.request("/WELCOME", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hello!" }),
    });
    expect(res.status).toBe(200);
    expect(await skills.getPrompt("WELCOME")).toBe("hello!");

    const keys = (await skills.promptRepo.list()).map((p) => p.key).sort();
    expect(keys).toEqual(["FORMAT", "SOUL", "WELCOME"]);
  });

  it("400s an unknown prompt key", async () => {
    const { app } = makeApp();

    const res = await app.request("/NONSENSE", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s a missing body field", async () => {
    const { app } = makeApp();

    const res = await app.request("/SOUL", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
