import { Hono } from "hono";
import { z } from "zod";
import { settings } from "../../db/schema.js";
import { SettingKey } from "../../config/settings-keys.js";
import { parseGoDuration } from "../../config/settings.js";
import { logger } from "../../pkg/logger.js";
import type { AdminEnv } from "./deps.js";

const log = logger.child({ mod: "admin-settings" });

/** A non-empty Go-duration string ("300s", "1h30m", "500ms") that parses to > 0 ms. */
const goDuration = z
  .string()
  .min(1)
  .refine((s) => parseGoDuration(s) > 0, { message: "invalid Go duration (e.g. '300s', '1h30m')" });

const timeoutsSchema = z.object({
  llm_request: goDuration,
  http_client: goDuration,
  llm_activity: goDuration,
});

const agentSchema = z.object({
  max_history: z.number().int().min(0),
  default_temperature: z.number().min(0).max(2),
});

/** Flatten zod issues to a single human-readable string (never echoes secret values). */
function zodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** Upsert a settings row (insert or replace value) — bumps updatedAt for hot-reload. */
async function upsertSetting(
  db: AdminEnv["Variables"]["deps"]["db"],
  key: string,
  value: unknown,
): Promise<void> {
  const now = new Date();
  await db
    .insert(settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
}

/**
 * Admin config router for global timeouts + agent params (mounted at /admin/api/settings).
 * Reads go through SettingsService (cache); writes upsert the `settings` row and
 * `invalidate()` the cache so the live chat picks up the change on next access.
 */
export function settingsRoutes(): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();

  r.get("/timeouts", async (c) => {
    const { settings: svc } = c.var.deps;
    log.debug({ adminUserId: c.var.adminUserId }, "read timeouts");
    return c.json(await svc.getTimeouts());
  });

  r.put("/timeouts", async (c) => {
    const { db, settings: svc } = c.var.deps;
    const body = await c.req.json().catch(() => undefined);
    const parsed = timeoutsSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ adminUserId: c.var.adminUserId }, "timeouts validation failed");
      return c.json({ error: zodError(parsed.error) }, 400);
    }
    await upsertSetting(db, SettingKey.Timeouts, parsed.data);
    svc.invalidate();
    log.info(
      { adminUserId: c.var.adminUserId, key: SettingKey.Timeouts },
      "timeouts updated",
    );
    return c.json({ ok: true, value: parsed.data });
  });

  r.get("/agent", async (c) => {
    const { settings: svc } = c.var.deps;
    log.debug({ adminUserId: c.var.adminUserId }, "read agent");
    return c.json(await svc.getAgent());
  });

  r.put("/agent", async (c) => {
    const { db, settings: svc } = c.var.deps;
    const body = await c.req.json().catch(() => undefined);
    const parsed = agentSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ adminUserId: c.var.adminUserId }, "agent validation failed");
      return c.json({ error: zodError(parsed.error) }, 400);
    }
    await upsertSetting(db, SettingKey.Agent, parsed.data);
    svc.invalidate();
    log.info({ adminUserId: c.var.adminUserId, key: SettingKey.Agent }, "agent updated");
    return c.json({ ok: true, value: parsed.data });
  });

  return r;
}
