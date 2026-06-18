import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  users,
  userChannels,
  userSubscriptions,
  subscriptionPlans,
} from "../../db/schema.js";
import { SettingKey } from "../../config/settings-keys.js";
import { settings as settingsTable } from "../../db/schema.js";
import { logger } from "../../pkg/logger.js";
import type { AdminEnv } from "./deps.js";

const log = logger.child({ mod: "admin-users" });

type Db = AdminEnv["Variables"]["deps"]["db"];

/** Sent to a user when their access request is approved (M17). */
const ACCESS_GRANTED_MSG =
  "Доступ открыт ✅ Можете пользоваться ботом — просто напишите сообщение.";

/** Partial profile patch — only the admin-editable fields, all optional. */
const userPatchSchema = z
  .object({
    display_name: z.string(),
    city: z.string(),
    timezone: z.string(),
    language: z.string(),
    onboarded: z.boolean(),
  })
  .partial();

/** Chat allowlist body: the Telegram user ids permitted to talk to the bot. */
const allowlistSchema = z.object({
  userIds: z.array(z.number().int()),
});

/** Access-mode body: `open` (legacy, empty=everyone) or `approval` (gated by requests). */
const accessModeSchema = z.object({
  mode: z.enum(["open", "approval"]),
});

/** Flatten zod issues to a single human-readable string (never echoes PII values). */
function zodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** Load a user's channels (provider/external_id pairs). */
async function channelsForUser(db: Db, userId: number) {
  return db
    .select({
      id: userChannels.id,
      provider: userChannels.provider,
      externalId: userChannels.externalId,
    })
    .from(userChannels)
    .where(eq(userChannels.userId, userId));
}

/** Load a user's current plan via user_subscriptions → subscription_plans, or null. */
async function planForUser(db: Db, userId: number) {
  const rows = await db
    .select({
      id: subscriptionPlans.id,
      name: subscriptionPlans.name,
      hourlyLimit: subscriptionPlans.hourlyLimit,
      maxTasks: subscriptionPlans.maxTasks,
    })
    .from(userSubscriptions)
    .innerJoin(subscriptionPlans, eq(userSubscriptions.planId, subscriptionPlans.id))
    .where(eq(userSubscriptions.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

/** Serialise a users row into the API shape (epoch-ms timestamps). */
function userInfo(row: typeof users.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    displayName: row.displayName,
    city: row.city,
    timezone: row.timezone,
    language: row.language,
    onboarded: row.onboarded,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/**
 * Admin user-management router (mounted at /admin/api/users).
 *
 * Lists/edits user profiles joined with their messaging channels and current
 * subscription plan, and manages the bot chat allowlist (the `telegram_allowed_users`
 * setting — who may chat with the bot; distinct from admin access, which is gated
 * by ADMIN_USER_IDS in the auth layer).
 */
export function usersRoutes(): Hono<AdminEnv> {
  const r = new Hono<AdminEnv>();

  // ── chat allowlist ────────────────────────────────────────────────────────
  // NOTE: declared before `/:id` so "allowlist" isn't captured as an id param.
  r.get("/allowlist", async (c) => {
    const { settings } = c.var.deps;
    log.debug({ adminUserId: c.var.adminUserId }, "read chat allowlist");
    const [userIds, mode] = await Promise.all([settings.getAllowedUsers(), settings.getAccessMode()]);
    return c.json({ userIds, mode });
  });

  r.put("/allowlist", async (c) => {
    const { db, settings } = c.var.deps;
    const body = await c.req.json().catch(() => undefined);
    const parsed = allowlistSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ adminUserId: c.var.adminUserId }, "allowlist validation failed");
      return c.json({ error: zodError(parsed.error) }, 400);
    }
    const now = new Date();
    await db
      .insert(settingsTable)
      .values({ key: SettingKey.TelegramAllowedUsers, value: parsed.data.userIds, updatedAt: now })
      .onConflictDoUpdate({
        target: settingsTable.key,
        set: { value: parsed.data.userIds, updatedAt: now },
      });
    settings.invalidate();
    log.info(
      { adminUserId: c.var.adminUserId, key: SettingKey.TelegramAllowedUsers, count: parsed.data.userIds.length },
      "chat allowlist updated",
    );
    return c.json({ ok: true, userIds: parsed.data.userIds });
  });

  r.put("/access-mode", async (c) => {
    const { db, settings } = c.var.deps;
    const body = await c.req.json().catch(() => undefined);
    const parsed = accessModeSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ adminUserId: c.var.adminUserId }, "access-mode validation failed");
      return c.json({ error: zodError(parsed.error) }, 400);
    }
    const now = new Date();
    await db
      .insert(settingsTable)
      .values({ key: SettingKey.TelegramAccessMode, value: parsed.data.mode, updatedAt: now })
      .onConflictDoUpdate({
        target: settingsTable.key,
        set: { value: parsed.data.mode, updatedAt: now },
      });
    settings.invalidate();
    log.info({ adminUserId: c.var.adminUserId, mode: parsed.data.mode }, "access mode updated");
    return c.json({ ok: true, mode: parsed.data.mode });
  });

  // ── access requests (M17) ───────────────────────────────────────────────────
  // Inbox of "let me in" requests created by the bot in approval mode. Approving
  // adds the tg id to the allowlist (via AccessRequestService) and notifies the user.
  r.get("/requests", async (c) => {
    const { accessRequests } = c.var.deps;
    log.debug({ adminUserId: c.var.adminUserId }, "list access requests");
    const rows = await accessRequests.listPending();
    return c.json({
      requests: rows.map((row) => ({
        id: row.id,
        tgUserId: row.tgUserId,
        name: row.name,
        username: row.username,
        status: row.status,
        createdAt: row.createdAt.getTime(),
      })),
    });
  });

  r.post("/requests/:id/approve", async (c) => {
    const { accessRequests, notify } = c.var.deps;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
    const result = await accessRequests.approve(id);
    if (!result) return c.json({ error: "request not found or already decided" }, 404);
    // Best-effort: never fail the approval if the user can't be reached (blocked bot, etc.).
    await notify?.(result.tgUserId, ACCESS_GRANTED_MSG)?.catch(() => {});
    log.info(
      { adminUserId: c.var.adminUserId, id, tgUserId: result.tgUserId },
      "access request approved",
    );
    return c.json({ ok: true });
  });

  r.post("/requests/:id/reject", async (c) => {
    const { accessRequests } = c.var.deps;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
    const ok = await accessRequests.reject(id);
    if (!ok) return c.json({ error: "request not found or already decided" }, 404);
    log.info({ adminUserId: c.var.adminUserId, id }, "access request rejected");
    return c.json({ ok: true });
  });

  // ── list / get / patch ────────────────────────────────────────────────────
  r.get("/", async (c) => {
    const { db } = c.var.deps;
    log.debug({ adminUserId: c.var.adminUserId }, "list users");
    const rows = await db.select().from(users);
    const out = await Promise.all(
      rows.map(async (row) => ({
        ...userInfo(row),
        channels: await channelsForUser(db, row.id),
        plan: await planForUser(db, row.id),
      })),
    );
    return c.json({ users: out });
  });

  r.get("/:id", async (c) => {
    const { db } = c.var.deps;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
    log.debug({ adminUserId: c.var.adminUserId, userId: id }, "get user");
    const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!row) return c.json({ error: "user not found" }, 404);
    return c.json({
      ...userInfo(row),
      channels: await channelsForUser(db, row.id),
      plan: await planForUser(db, row.id),
    });
  });

  r.patch("/:id", async (c) => {
    const { db } = c.var.deps;
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);

    const body = await c.req.json().catch(() => undefined);
    const parsed = userPatchSchema.safeParse(body);
    if (!parsed.success) {
      log.warn({ adminUserId: c.var.adminUserId, userId: id }, "user patch validation failed");
      return c.json({ error: zodError(parsed.error) }, 400);
    }

    const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
    if (parsed.data.display_name !== undefined) patch.displayName = parsed.data.display_name;
    if (parsed.data.city !== undefined) patch.city = parsed.data.city;
    if (parsed.data.timezone !== undefined) patch.timezone = parsed.data.timezone;
    if (parsed.data.language !== undefined) patch.language = parsed.data.language;
    if (parsed.data.onboarded !== undefined) patch.onboarded = parsed.data.onboarded;

    const updated = await db
      .update(users)
      .set(patch)
      .where(eq(users.id, id))
      .returning();
    if (!updated[0]) return c.json({ error: "user not found" }, 404);

    log.info({ adminUserId: c.var.adminUserId, userId: id }, "user updated");
    return c.json({
      ...userInfo(updated[0]),
      channels: await channelsForUser(db, id),
      plan: await planForUser(db, id),
    });
  });

  return r;
}
