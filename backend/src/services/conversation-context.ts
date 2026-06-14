import { eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../db/schema.js";
import { users, sessions, botIdentities } from "../db/schema.js";
import { User, Session, BotIdentity } from "../domain/entities.js";
import { SettingsService } from "../config/settings.js";
import { resolveThreadId, resourceIdForUser } from "../mastra/memory/history.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "conversation-context" });

type Db = LibSQLDatabase<typeof schema>;

export interface ConversationContext {
  user: User;
  session: Session;
  identity: BotIdentity | null;
  threadId: string;
  resourceId: string;
}

/**
 * Resolve everything the chat workflow needs for one turn: the user, a session
 * for the chat (created on first contact, model = roles.default), the optional
 * bot identity, and the Mastra Memory thread/resource ids.
 *
 * Boundary: the user is looked up by id — get-or-create of users from a Telegram
 * channel (`user_channels`) belongs to the Telegram layer (M6).
 */
export async function loadContext(
  db: Db,
  settings: SettingsService,
  userId: number,
  chatId: number,
): Promise<ConversationContext> {
  const [userRow] = await db.select().from(users).where(eq(users.id, userId));
  if (!userRow) throw new Error(`loadContext: user ${userId} not found`);
  const user = User.parse(userRow);

  const session = await getOrCreateSession(db, settings, userId, chatId);

  const [identityRow] = await db.select().from(botIdentities).where(eq(botIdentities.userId, userId));
  const identity = identityRow ? BotIdentity.parse(identityRow) : null;

  const threadId = await resolveThreadId(db, session.id);
  const resourceId = resourceIdForUser(userId);

  log.debug(
    { userId, chatId, sessionId: session.id, threadId, hasIdentity: identity !== null },
    "conversation context loaded",
  );
  return { user, session, identity, threadId, resourceId };
}

async function getOrCreateSession(
  db: Db,
  settings: SettingsService,
  userId: number,
  chatId: number,
): Promise<Session> {
  const [existing] = await db.select().from(sessions).where(eq(sessions.chatId, chatId));
  if (existing) return Session.parse(existing);

  const roles = await settings.getModelRoles();
  // onConflictDoNothing guards the chatId UNIQUE constraint against a concurrent
  // first-contact race; if we lost the race, re-select the winner's row.
  const [created] = await db
    .insert(sessions)
    .values({ chatId, userId, model: roles.default })
    .onConflictDoNothing()
    .returning();
  if (created) {
    log.info({ chatId, userId, model: roles.default }, "session created");
    return Session.parse(created);
  }
  const [row] = await db.select().from(sessions).where(eq(sessions.chatId, chatId));
  return Session.parse(row!);
}
