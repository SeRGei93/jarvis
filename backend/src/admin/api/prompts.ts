import { Hono } from "hono";
import { z } from "zod";
import { KNOWN_PROMPT_KEYS, type StoredPrompt } from "../../content/prompt-repository.js";
import { logger } from "../../pkg/logger.js";
import type { AdminEnv } from "./deps.js";

const log = logger.child({ mod: "admin-prompts" });

/** Admin is TRUSTED: type + length cap only, NO promptguard injection checks. */
const MAX_BODY_LEN = 20_000;
const updateSchema = z.object({
  body: z.string().max(MAX_BODY_LEN),
});

/** Serialise a stored prompt into the API shape. */
function toApi(stored: StoredPrompt) {
  return { key: stored.key, body: stored.body, updatedAt: stored.updatedAt.toISOString() };
}

/**
 * Admin REST router for system prompts: read all / read one / upsert one.
 * Mounted at `/admin/api/prompts`; routes here are RELATIVE to that mount.
 * Prompts live in the file-backed content store (`PROMPTS_DIR`); an upsert writes
 * the `<KEY>.md` file atomically and the repository self-invalidates its cache.
 */
export function promptsRoutes(): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  // GET / — all prompts.
  app.get("/", async (c) => {
    const { skills } = c.var.deps;
    log.debug({ adminUserId: c.var.adminUserId }, "list prompts");
    const stored = await skills.promptRepo.list();
    return c.json(stored.map(toApi));
  });

  // GET /:key — one prompt or 404.
  app.get("/:key", async (c) => {
    const { skills } = c.var.deps;
    const key = c.req.param("key");
    log.debug({ adminUserId: c.var.adminUserId, key }, "get prompt");
    const stored = await skills.promptRepo.getStored(key);
    if (!stored) return c.json({ error: "prompt not found" }, 404);
    return c.json(toApi(stored));
  });

  // PUT /:key — upsert the body (writes <KEY>.md atomically + invalidates cache).
  app.put("/:key", async (c) => {
    const { skills } = c.var.deps;
    const key = c.req.param("key");
    const body = await c.req.json().catch(() => null);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ adminUserId: c.var.adminUserId, key }, "update prompt: invalid body");
      return c.json({ error: "invalid prompt", details: parsed.error.flatten() }, 400);
    }
    // Only known keys are accepted — this also blocks path traversal in the key.
    if (!KNOWN_PROMPT_KEYS.includes(key)) {
      log.warn({ adminUserId: c.var.adminUserId, key }, "update prompt: unknown key");
      return c.json({ error: "unknown prompt key" }, 400);
    }

    const stored = await skills.promptRepo.upsert(key, parsed.data.body);
    log.info({ adminUserId: c.var.adminUserId, key }, "prompt updated");
    return c.json(toApi(stored));
  });

  return app;
}
