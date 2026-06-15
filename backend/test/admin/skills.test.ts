import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import { skillsRoutes, type SkillRunFn } from "../../src/admin/api/skills.js";
import type { AdminEnv } from "../../src/admin/api/deps.js";
import type { AdminApiDeps } from "../../src/admin/api/deps.js";
import { tempContent, type ContentFixture, type SkillInput } from "../helpers/content.js";
import type { SettingsService } from "../../src/config/settings.js";
import type { LlmService } from "../../src/mastra/llm.js";

let c: ContentFixture | undefined;
afterEach(() => {
  c?.cleanup();
  c = undefined;
});

const settings = {
  getModelRoles: async () => ({
    default: "openrouter:default",
    router: "openrouter:router",
    embedding: "openrouter:embed",
    error_correction: "openrouter:ec",
    speech: "openrouter:speech",
    synthesizer: "openrouter:synth",
  }),
  getAgent: async () => ({ max_history: 15, default_temperature: 0.4, rag_top_k: 10 }),
  getTimeouts: async () => ({ llm_request: "300s", http_client: "300s", llm_activity: "30s" }),
} as unknown as SettingsService;

/** Fake LLM that the default sub-agent path would call if no runFn override is given. */
const llm = {
  generate: async () => ({ text: "REAL", cost: 0.002 }),
  stream: async () => ({ text: "REAL", cost: 0.002 }),
} as unknown as LlmService;

/** A test-run fake that bypasses the model entirely (offline). */
const fakeRun: SkillRunFn = async (_deps, skill, ctx) => ({
  text: `RAN:${skill.name}:${ctx.userMessage}`,
  cost: 0.0,
});

const RESEARCH: SkillInput = {
  name: "research",
  description: "deep research",
  allowedTools: ["memory_search"],
  model: "",
  routable: true,
  prompt: "Be a researcher.",
  metadata: { area: "general" },
};

function makeApp(runFn: SkillRunFn = fakeRun) {
  c = tempContent({ skills: [RESEARCH] });
  const deps = {
    settings,
    skills: c.skills,
    llm,
    memoryService: {},
  } as unknown as AdminApiDeps;

  const app = new Hono<AdminEnv>();
  app.use("*", async (ctx, next) => {
    ctx.set("deps", deps);
    ctx.set("adminUserId", 1);
    await next();
  });
  app.route("/", skillsRoutes(runFn));
  return { app, skills: c.skills, deps };
}

describe("skillsRoutes CRUD", () => {
  it("lists all skills", async () => {
    const { app } = makeApp();

    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ name: string }>;
    expect(body.map((s) => s.name)).toEqual(["research"]);
  });

  it("gets one skill, 404 for unknown", async () => {
    const { app } = makeApp();

    const ok = await app.request("/research");
    expect(ok.status).toBe(200);
    expect((await ok.json()).name).toBe("research");

    const missing = await app.request("/nope");
    expect(missing.status).toBe(404);
  });

  it("creates a skill and invalidates the SkillService cache", async () => {
    const { app, skills } = makeApp();

    // Warm the cache so we prove the write actually re-reads.
    expect(await skills.getSkillByName("weather")).toBeNull();

    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "weather",
        description: "weather lookups",
        allowedTools: ["currency_convert"],
        temperature: 0.2,
        routable: true,
        prompt: "Report the weather.",
      }),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.name).toBe("weather");
    expect(created.temperature).toBe(0.2);

    // Proves the cache reloaded: the new skill is now visible through the service.
    const fromService = await skills.getSkillByName("weather");
    expect(fromService?.name).toBe("weather");
    expect(fromService?.routable).toBe(true);
  });

  it("rejects a duplicate name with 409", async () => {
    const { app } = makeApp();

    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "research", prompt: "x" }),
    });
    expect(res.status).toBe(409);
  });

  it("rejects invalid input with 400 (bad temperature)", async () => {
    const { app } = makeApp();

    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bad", temperature: 9 }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unsafe skill name with 400", async () => {
    const { app } = makeApp();

    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "../escape", prompt: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("updates a skill partially and invalidates the cache", async () => {
    const { app, skills } = makeApp();
    // Warm cache.
    expect((await skills.getSkillByName("research"))?.routable).toBe(true);

    const res = await app.request("/research", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routable: false, description: "updated" }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.routable).toBe(false);
    expect(updated.description).toBe("updated");
    // Original prompt is untouched (partial update).
    expect(updated.prompt).toBe("Be a researcher.");

    const fromService = await skills.getSkillByName("research");
    expect(fromService?.routable).toBe(false);
  });

  it("404s on update of an unknown skill", async () => {
    const { app } = makeApp();
    const res = await app.request("/nope", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("deletes a skill and invalidates the cache", async () => {
    const { app, skills } = makeApp();
    expect(await skills.getSkillByName("research")).not.toBeNull();

    const res = await app.request("/research", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await skills.getSkillByName("research")).toBeNull();
    expect(await skills.getAllSkills()).toHaveLength(0);
  });

  it("404s on delete of an unknown skill", async () => {
    const { app } = makeApp();
    const res = await app.request("/nope", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("skillsRoutes test-run", () => {
  it("runs a skill against a message and returns text + usage (offline)", async () => {
    const { app } = makeApp(fakeRun);

    const res = await app.request("/research/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "find cats" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; usage: { cost: number } };
    expect(body.text).toBe("RAN:research:find cats");
    expect(body.usage).toEqual({ cost: 0 });
  });

  it("404s a test-run for an unknown skill", async () => {
    const { app } = makeApp(fakeRun);
    const res = await app.request("/nope/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s a test-run with an empty message", async () => {
    const { app } = makeApp(fakeRun);
    const res = await app.request("/research/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns a 502 error JSON when the run throws (never throws out of the handler)", async () => {
    const boom: SkillRunFn = async () => {
      throw new Error("model exploded");
    };
    const { app } = makeApp(boom);

    const res = await app.request("/research/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("model exploded");
  });
});
