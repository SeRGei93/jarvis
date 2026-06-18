import { eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../db/schema.js";
import { accessRequests, userChannels, settings as settingsTable } from "../db/schema.js";
import { SettingKey } from "../config/settings-keys.js";
import type { SettingsService } from "../config/settings.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "access-requests" });

type Db = LibSQLDatabase<typeof schema>;

// Mirrors telegram/identity.ts TELEGRAM_PROVIDER. Inlined here to keep the
// dependency direction clean (services must not import the telegram adapter).
const TELEGRAM_PROVIDER = "telegram";

/** Telegram contact captured at the gate when an unknown user writes. */
export interface TelegramContact {
  /** Telegram user id (`ctx.from.id`). */
  id: number;
  /** Display name (`first_name [last_name]`). */
  name?: string;
  /** `@username` without the `@`, if the user has one. */
  username?: string;
}

/** An access_requests row as returned by the admin API. */
export type AccessRequestRow = typeof accessRequests.$inferSelect;

/**
 * Manages the bot access-request inbox (the `access_requests` table) and the
 * actual gate it feeds — the `telegram_allowed_users` setting. When access mode is
 * `approval`, the bot calls {@link record} for unknown users; the admin then
 * {@link approve}s (→ tg id added to the allowlist) or {@link reject}s.
 *
 * DI: takes `db` + `SettingsService` so an approval write invalidates the very
 * cache the bot's gate reads (single-process — see {@link ensureAccessControlDefaults}).
 */
export class AccessRequestService {
  constructor(
    private readonly db: Db,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Upsert a pending request for `tg`. Returns `{ created: true }` only the first
   * time (a fresh pending row was inserted) so the caller replies "request sent"
   * exactly once. A repeat contact refreshes name/username but leaves the status
   * untouched — a rejected user stays rejected and is not re-prompted.
   */
  async record(tg: TelegramContact): Promise<{ created: boolean }> {
    const tgUserId = tg.id;
    const name = (tg.name ?? "").trim();
    const username = tg.username?.trim() || null;
    log.debug({ tgUserId }, "record access request");

    // SQLite serializes write transactions, so select→insert can't race within
    // one DB; the UNIQUE(tg_user_id) + onConflictDoNothing is the backstop.
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: accessRequests.id, status: accessRequests.status })
        .from(accessRequests)
        .where(eq(accessRequests.tgUserId, tgUserId));
      if (existing) {
        await tx
          .update(accessRequests)
          .set({ name, username, updatedAt: new Date() })
          .where(eq(accessRequests.id, existing.id));
        log.debug({ tgUserId, status: existing.status }, "access request already on file");
        return { created: false };
      }
      // No existing row → this call creates it. onConflictDoNothing is a backstop;
      // it can't actually fire here because SQLite serializes write transactions
      // (a concurrent first-contact would have been seen by the select above).
      await tx.insert(accessRequests).values({ tgUserId, name, username }).onConflictDoNothing();
      log.info({ tgUserId }, "access request recorded");
      return { created: true };
    });
  }

  /** Pending requests, oldest first (the admin's review queue). */
  async listPending(): Promise<AccessRequestRow[]> {
    return this.list("pending");
  }

  /** All requests (optionally filtered by status), oldest first. */
  async list(status?: string): Promise<AccessRequestRow[]> {
    log.debug({ status: status ?? "all" }, "list access requests");
    return this.db
      .select()
      .from(accessRequests)
      .where(status ? eq(accessRequests.status, status) : undefined)
      .orderBy(accessRequests.createdAt);
  }

  /**
   * Approve a pending request: mark it approved and add its tg id to the
   * `telegram_allowed_users` allowlist (the actual gate). Returns the contact for
   * the "access granted" notification, or `null` when the request is missing or
   * already decided (the handler maps `null` → 404).
   */
  async approve(id: number): Promise<{ tgUserId: number; name: string } | null> {
    log.debug({ id }, "approve access request");
    const [row] = await this.db
      .select({
        tgUserId: accessRequests.tgUserId,
        name: accessRequests.name,
        status: accessRequests.status,
      })
      .from(accessRequests)
      .where(eq(accessRequests.id, id));
    if (!row || row.status !== "pending") {
      log.warn({ id, status: row?.status ?? "missing" }, "approve: not a pending request");
      return null;
    }
    const now = new Date();
    await this.db
      .update(accessRequests)
      .set({ status: "approved", decidedAt: now, updatedAt: now })
      .where(eq(accessRequests.id, id));
    await this.addToAllowlist(row.tgUserId);
    log.info({ id, tgUserId: row.tgUserId }, "access request approved");
    return { tgUserId: row.tgUserId, name: row.name };
  }

  /** Reject a pending request (terminal). Returns false when missing/already decided. */
  async reject(id: number): Promise<boolean> {
    log.debug({ id }, "reject access request");
    const [row] = await this.db
      .select({ status: accessRequests.status })
      .from(accessRequests)
      .where(eq(accessRequests.id, id));
    if (!row || row.status !== "pending") {
      log.warn({ id, status: row?.status ?? "missing" }, "reject: not a pending request");
      return false;
    }
    const now = new Date();
    await this.db
      .update(accessRequests)
      .set({ status: "rejected", decidedAt: now, updatedAt: now })
      .where(eq(accessRequests.id, id));
    log.info({ id }, "access request rejected");
    return true;
  }

  /** Add a tg id to the allowlist setting (idempotent) and invalidate the cache. */
  private async addToAllowlist(tgUserId: number): Promise<void> {
    const current = await this.settings.getAllowedUsers();
    if (current.includes(tgUserId)) {
      log.debug({ tgUserId }, "already in allowlist");
      return;
    }
    const next = [...current, tgUserId];
    const now = new Date();
    await this.db
      .insert(settingsTable)
      .values({ key: SettingKey.TelegramAllowedUsers, value: next, updatedAt: now })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value: next, updatedAt: now } });
    this.settings.invalidate();
    log.info({ tgUserId, count: next.length }, "allowlist updated");
  }
}

/**
 * One-time, idempotent bootstrap that opts a deployment into approval-gated access
 * without locking anyone out. If the `telegram_access_mode` setting is absent:
 *   1. merge every existing Telegram user (from `user_channels`) into the allowlist,
 *   2. set `telegram_access_mode = "approval"`.
 * Guarded by the mode key's absence so it runs exactly once. Call from the server
 * composition root (NOT from createChatService — tests must stay on the open default).
 */
export async function ensureAccessControlDefaults(
  db: Db,
  settings: SettingsService,
): Promise<void> {
  const [existing] = await db
    .select({ key: settingsTable.key })
    .from(settingsTable)
    .where(eq(settingsTable.key, SettingKey.TelegramAccessMode));
  if (existing) {
    log.debug("access mode already configured; skip bootstrap");
    return;
  }

  const current = await settings.getAllowedUsers();
  const channels = await db
    .select({ externalId: userChannels.externalId })
    .from(userChannels)
    .where(eq(userChannels.provider, TELEGRAM_PROVIDER));
  const tgIds = channels.map((c) => Number(c.externalId)).filter((n) => Number.isInteger(n));
  const merged = Array.from(new Set([...current, ...tgIds]));

  const now = new Date();
  await db
    .insert(settingsTable)
    .values({ key: SettingKey.TelegramAllowedUsers, value: merged, updatedAt: now })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: merged, updatedAt: now } });
  await db
    .insert(settingsTable)
    .values({ key: SettingKey.TelegramAccessMode, value: "approval", updatedAt: now })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value: "approval", updatedAt: now } });
  settings.invalidate();
  log.info({ merged: merged.length, mode: "approval" }, "access control defaults applied");
}
