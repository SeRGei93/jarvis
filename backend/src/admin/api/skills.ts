import { Hono } from "hono";
import { z } from "zod";
import { isValidSkillName, type StoredSkill } from "../../content/skill-repository.js";
import { parseGoDuration } from "../../config/settings.js";
import {
  runSkillSubAgent,
  type SkillRunContext,
  type SkillRunResult,
} from "../../mastra/agents/skill-agent.js";
import type { Skill } from "../../domain/entities.js";
import { LoopGuard } from "../../mastra/agents/loop-guard.js";
import { logger } from "../../pkg/logger.js";
import type { AdminEnv } from "./deps.js";
import type { AdminApiDeps } from "./deps.js";

const log = logger.child({ mod: "admin-skills" });

/** Default overall watchdog when settings provide no usable llm_request value. */
const DEFAULT_TEST_RUN_MS = 300_000;

// ── input schemas (admin is TRUSTED: types + length caps, NO promptguard) ─────
const MAX_PROMPT_LEN = 20_000;
const MAX_DESCRIPTION_LEN = 2_000;
const MAX_NAME_LEN = 200;
const MAX_TOOL_LEN = 200;
const MAX_MODEL_LEN = 200;
const MAX_TEST_MESSAGE_LEN = 20_000;

const allowedToolsSchema = z.array(z.string().max(MAX_TOOL_LEN)).max(200);
const metadataSchema = z.record(z.string().max(200), z.string().max(2_000));

const createSchema = z.object({
  name: z.string().min(1).max(MAX_NAME_LEN),
  description: z.string().max(MAX_DESCRIPTION_LEN).default(""),
  allowedTools: allowedToolsSchema.default([]),
  model: z.string().max(MAX_MODEL_LEN).nullable().default(null),
  temperature: z.number().min(0).max(2).nullable().default(null),
  reasoning: z.boolean().nullable().default(null),
  routable: z.boolean().default(false),
  prompt: z.string().max(MAX_PROMPT_LEN).default(""),
  metadata: metadataSchema.default({}),
});

const updateSchema = z.object({
  description: z.string().max(MAX_DESCRIPTION_LEN).optional(),
  allowedTools: allowedToolsSchema.optional(),
  model: z.string().max(MAX_MODEL_LEN).nullable().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  reasoning: z.boolean().nullable().optional(),
  routable: z.boolean().optional(),
  prompt: z.string().max(MAX_PROMPT_LEN).optional(),
  metadata: metadataSchema.optional(),
});

const testSchema = z.object({
  message: z.string().min(1).max(MAX_TEST_MESSAGE_LEN),
});

/** Serialise a stored skill into the API shape (model "" -> null for the UI). */
function toApi(stored: StoredSkill) {
  const s = stored.skill;
  return {
    name: s.name,
    description: s.description,
    allowedTools: s.allowedTools,
    model: s.model === "" ? null : s.model,
    temperature: s.temperature ?? null,
    reasoning: s.reasoning ?? null,
    routable: s.routable,
    prompt: s.prompt,
    metadata: s.metadata,
    updatedAt: stored.updatedAt.toISOString(),
  };
}

/**
 * How a single test-run is executed. Defaults to {@link runSkillSubAgent}
 * (the non-streaming sub-agent path) but is injectable so tests can run offline.
 */
export type SkillRunFn = (
  deps: { llm: AdminApiDeps["llm"]; loopGuard: LoopGuard },
  skill: Skill,
  ctx: SkillRunContext,
) => Promise<SkillRunResult>;

/**
 * Run ONE non-streaming generation of `skill` against `message`, bounded by the
 * configured llm_request watchdog. Reuses the chat stack's deps (llm/db/settings/
 * memoryService) so it behaves like the live single-skill path, minus streaming
 * and history. `runFn` is injectable so the route is testable without network.
 */
export async function runSkillTest(
  deps: AdminApiDeps,
  skill: Skill,
  message: string,
  runFn: SkillRunFn = runSkillSubAgent,
): Promise<SkillRunResult> {
  const [roles, agentCfg, timeouts, prompts] = await Promise.all([
    deps.settings.getModelRoles(),
    deps.settings.getAgent(),
    deps.settings.getTimeouts(),
    deps.skills.getCorePrompts(),
  ]);
  const defaultModel = roles.default;

  const ctx: SkillRunContext = {
    user: null,
    identity: null,
    memories: [],
    prompts: { soul: prompts.soul, format: prompts.format, integrity: prompts.integrity },
    history: [],
    userMessage: message,
    mem: deps.memoryService,
    userId: 0,
    defaultModel,
    defaultTemperature: agentCfg.default_temperature,
    // Admin test-runs are not bound to a real session; tools that need a real
    // user/session are exercised in the live chat, not here. Use sentinel ids.
    chatId: 0,
    sessionId: 0,
    db: deps.db,
    settings: deps.settings,
  };

  const overallMs = parseGoDuration(timeouts.llm_request) || DEFAULT_TEST_RUN_MS;
  // Fresh LoopGuard per run so repeated admin tests are never loop-blocked.
  const runDeps = { llm: deps.llm, loopGuard: new LoopGuard() };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("test-run timed out")), overallMs);
  });
  try {
    return await Promise.race([runFn(runDeps, skill, ctx), watchdog]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Admin REST router for skill CRUD + a single test-run.
 * Mounted at `/admin/api/skills`; routes here are RELATIVE to that mount.
 * `runFn` is injectable purely so the test-run endpoint can be exercised offline.
 */
export function skillsRoutes(runFn: SkillRunFn = runSkillSubAgent): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  // GET / — all skills.
  app.get("/", async (c) => {
    const { skills } = c.var.deps;
    log.debug({ adminUserId: c.var.adminUserId }, "list skills");
    const stored = await skills.skillRepo.listStored();
    return c.json(stored.map(toApi));
  });

  // GET /:name — one skill or 404.
  app.get("/:name", async (c) => {
    const { skills } = c.var.deps;
    const name = c.req.param("name");
    log.debug({ adminUserId: c.var.adminUserId, name }, "get skill");
    const stored = await skills.skillRepo.getStored(name);
    if (!stored) return c.json({ error: "skill not found" }, 404);
    return c.json(toApi(stored));
  });

  // POST / — create (name must be unique).
  app.post("/", async (c) => {
    const { skills } = c.var.deps;
    const body = await c.req.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ adminUserId: c.var.adminUserId }, "create skill: invalid body");
      return c.json({ error: "invalid skill", details: parsed.error.flatten() }, 400);
    }
    const data = parsed.data;

    // Security: the name is the on-disk directory — reject traversal/separators.
    if (!isValidSkillName(data.name)) {
      log.warn({ adminUserId: c.var.adminUserId, name: data.name }, "create skill: invalid name");
      return c.json({ error: "invalid skill name (use letters, digits, - and _)" }, 400);
    }

    if (await skills.skillRepo.getByName(data.name)) {
      log.warn({ adminUserId: c.var.adminUserId, name: data.name }, "create skill: name exists");
      return c.json({ error: "skill already exists" }, 409);
    }

    const stored = await skills.skillRepo.upsert({
      name: data.name,
      description: data.description,
      allowedTools: data.allowedTools,
      model: data.model ?? "",
      temperature: data.temperature,
      reasoning: data.reasoning,
      routable: data.routable,
      prompt: data.prompt,
      metadata: data.metadata,
    });

    log.info({ adminUserId: c.var.adminUserId, name: data.name }, "skill created");
    return c.json(toApi(stored), 201);
  });

  // PUT /:name — partial update.
  app.put("/:name", async (c) => {
    const { skills } = c.var.deps;
    const name = c.req.param("name");
    const body = await c.req.json().catch(() => null);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ adminUserId: c.var.adminUserId, name }, "update skill: invalid body");
      return c.json({ error: "invalid skill", details: parsed.error.flatten() }, 400);
    }
    const data = parsed.data;

    const existing = await skills.skillRepo.getByName(name);
    if (!existing) return c.json({ error: "skill not found" }, 404);

    // Merge the patch onto the existing skill; name is immutable (path-addressed).
    const merged = {
      ...existing,
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.allowedTools !== undefined ? { allowedTools: data.allowedTools } : {}),
      ...(data.model !== undefined ? { model: data.model ?? "" } : {}),
      ...(data.temperature !== undefined ? { temperature: data.temperature } : {}),
      ...(data.reasoning !== undefined ? { reasoning: data.reasoning } : {}),
      ...(data.routable !== undefined ? { routable: data.routable } : {}),
      ...(data.prompt !== undefined ? { prompt: data.prompt } : {}),
      ...(data.metadata !== undefined ? { metadata: data.metadata } : {}),
    };

    const stored = await skills.skillRepo.upsert(merged);
    log.info({ adminUserId: c.var.adminUserId, name }, "skill updated");
    return c.json(toApi(stored));
  });

  // DELETE /:name — delete.
  app.delete("/:name", async (c) => {
    const { skills } = c.var.deps;
    const name = c.req.param("name");
    if (!isValidSkillName(name) || !(await skills.skillRepo.delete(name))) {
      return c.json({ error: "skill not found" }, 404);
    }
    log.info({ adminUserId: c.var.adminUserId, name }, "skill deleted");
    return c.json({ ok: true });
  });

  // POST /:name/test — single non-streaming test-run. Never throws out of the handler.
  app.post("/:name/test", async (c) => {
    const { skills } = c.var.deps;
    const name = c.req.param("name");
    const body = await c.req.json().catch(() => null);
    const parsed = testSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ adminUserId: c.var.adminUserId, name }, "test-run: invalid body");
      return c.json({ error: "invalid request", details: parsed.error.flatten() }, 400);
    }

    const skill = await skills.skillRepo.getByName(name);
    if (!skill) return c.json({ error: "skill not found" }, 404);

    log.info({ adminUserId: c.var.adminUserId, name }, "test-run start");
    try {
      const res = await runSkillTest(c.var.deps, skill, parsed.data.message, runFn);
      log.info({ adminUserId: c.var.adminUserId, name, cost: res.cost }, "test-run done");
      // Mirror the LLM accounting: expose `usage` to the admin UI as cost.
      return c.json({ text: res.text, usage: { cost: res.cost } });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn({ adminUserId: c.var.adminUserId, name, reason }, "test-run failed");
      return c.json({ error: reason }, 502);
    }
  });

  return app;
}
