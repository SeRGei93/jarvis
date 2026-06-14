import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { prompts as promptsTable } from "../../db/schema.js";
import { logger } from "../../pkg/logger.js";
import type { AdminEnv } from "./deps.js";

const log = logger.child({ mod: "admin-prompts" });

/** System prompt keys the UI surfaces (matches the seeded `prompts` table). */
const KNOWN_KEYS = ["SOUL", "FORMAT", "INTEGRITY", "SYNTHESIZER", "WELCOME", "MONITORING"];

/** Admin is TRUSTED: type + length cap only, NO promptguard injection checks. */
const MAX_BODY_LEN = 20_000;
const updateSchema = z.object({
  body: z.string().max(MAX_BODY_LEN),
});

/** Serialise a DB row into the API shape. */
function toApi(row: typeof promptsTable.$inferSelect) {
  return { key: row.key, body: row.body, updatedAt: row.updatedAt.toISOString() };
}

/**
 * Admin REST router for system prompts: read all / read one / upsert one.
 * Mounted at `/admin/api/prompts`; routes here are RELATIVE to that mount.
 * Prompt bodies feed SkillService's prompt cache, so an upsert invalidates it.
 */
export function promptsRoutes(): Hono<AdminEnv> {
  const app = new Hono<AdminEnv>();

  // GET / — all prompts.
  app.get("/", async (c) => {
    const { db } = c.var.deps;
    log.debug({ adminUserId: c.var.adminUserId }, "list prompts");
    const rows = await db.select().from(promptsTable);
    return c.json(rows.map(toApi));
  });

  // GET /:key — one prompt or 404.
  app.get("/:key", async (c) => {
    const { db } = c.var.deps;
    const key = c.req.param("key");
    log.debug({ adminUserId: c.var.adminUserId, key }, "get prompt");
    const [row] = await db.select().from(promptsTable).where(eq(promptsTable.key, key)).limit(1);
    if (!row) return c.json({ error: "prompt not found" }, 404);
    return c.json(toApi(row));
  });

  // PUT /:key — upsert the body, then invalidate the SkillService prompt cache.
  app.put("/:key", async (c) => {
    const { db, skills } = c.var.deps;
    const key = c.req.param("key");
    const body = await c.req.json().catch(() => null);
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ adminUserId: c.var.adminUserId, key }, "update prompt: invalid body");
      return c.json({ error: "invalid prompt", details: parsed.error.flatten() }, 400);
    }
    if (!KNOWN_KEYS.includes(key)) {
      log.warn({ adminUserId: c.var.adminUserId, key }, "update prompt: unknown key");
      return c.json({ error: "unknown prompt key" }, 400);
    }

    const now = new Date();
    const [row] = await db
      .insert(promptsTable)
      .values({ key, body: parsed.data.body, updatedAt: now })
      .onConflictDoUpdate({
        target: promptsTable.key,
        set: { body: parsed.data.body, updatedAt: now },
      })
      .returning();

    await skills.invalidate();
    log.info({ adminUserId: c.var.adminUserId, key }, "prompt updated");
    return c.json(toApi(row!));
  });

  return app;
}
