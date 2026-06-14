import { and, eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../db/schema.js";
import { users, userChannels } from "../db/schema.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "tg-identity" });

type Db = LibSQLDatabase<typeof schema>;

/** Channel provider key for Telegram users. */
export const TELEGRAM_PROVIDER = "telegram";

/** Minimal Telegram user info the resolver needs (from grammY `ctx.from`). */
export interface TelegramUserInfo {
  /** Telegram user id (`ctx.from.id`). */
  id: number;
  /** Display name (e.g. `first_name [last_name]`); stored as `users.name`. */
  name?: string;
}

export interface ResolvedUser {
  /** Internal `users.id` to pass to `handleUserMessage`. */
  userId: number;
  /** True when this contact created a fresh user row. */
  created: boolean;
}

/**
 * Get-or-create the internal user for a Telegram contact. This is the Telegram
 * layer's responsibility (see conversation-context.ts boundary note): `loadContext`
 * looks the user up by id and throws if missing, so the bot must resolve the
 * `user_channels` (provider='telegram', external_id) row first.
 *
 * Idempotent: a repeat contact returns the same id. The lookup + inserts run in a
 * transaction; the `UNIQUE(provider, external_id)` constraint guards a first-contact race.
 */
export async function resolveTelegramUser(db: Db, tg: TelegramUserInfo): Promise<ResolvedUser> {
  const externalId = String(tg.id);
  const name = (tg.name ?? "").trim();

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ userId: userChannels.userId })
      .from(userChannels)
      .where(and(eq(userChannels.provider, TELEGRAM_PROVIDER), eq(userChannels.externalId, externalId)));
    if (existing) {
      log.debug({ externalId }, "telegram user resolved (existing)");
      return { userId: existing.userId, created: false };
    }

    const [created] = await tx.insert(users).values({ name }).returning({ id: users.id });
    const userId = created!.id;
    await tx
      .insert(userChannels)
      .values({ userId, provider: TELEGRAM_PROVIDER, externalId })
      .onConflictDoNothing();

    // Re-read to settle a concurrent first-contact race (the constraint may have
    // pointed external_id at a different user that won the insert).
    const [channel] = await tx
      .select({ userId: userChannels.userId })
      .from(userChannels)
      .where(and(eq(userChannels.provider, TELEGRAM_PROVIDER), eq(userChannels.externalId, externalId)));
    const winnerId = channel!.userId;

    log.info({ userId: winnerId, created: winnerId === userId }, "telegram user resolved (new)");
    return { userId: winnerId, created: winnerId === userId };
  });
}
