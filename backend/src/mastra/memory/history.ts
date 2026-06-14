import { Memory } from "@mastra/memory";
import type { LibSQLStore } from "@mastra/libsql";
import { eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../../db/schema.js";
import { sessions } from "../../db/schema.js";
import { logger } from "../../pkg/logger.js";

const log = logger.child({ mod: "history" });
type Db = LibSQLDatabase<typeof schema>;

/**
 * Mastra Memory for conversation history, backed by libSQL (mastra_threads /
 * mastra_messages). Messages are stored in plaintext — no encryption (ROADMAP §5/§6).
 * Skill agents (M4) attach this and pass thread/resource ids to read/write history.
 * `lastMessages` = settings.agent.max_history.
 */
export function createConversationMemory(storage: LibSQLStore, lastMessages: number): Memory {
  return new Memory({
    storage,
    options: {
      lastMessages,
      semanticRecall: false,
      workingMemory: { enabled: false },
    },
  });
}

/** Mastra resource id for a user (groups that user's threads). */
export function resourceIdForUser(userId: number): string {
  return `user:${userId}`;
}

/** Stable Mastra thread id for a session. */
export function threadIdForSession(sessionId: number): string {
  return `session-${sessionId}`;
}

/** Ensure the session is linked to a Mastra thread id; persist and return it. */
export async function resolveThreadId(db: Db, sessionId: number): Promise<string> {
  const [s] = await db
    .select({ threadId: sessions.threadId })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  if (s?.threadId) {
    log.debug({ sessionId, threadId: s.threadId }, "thread resolved");
    return s.threadId;
  }
  const threadId = threadIdForSession(sessionId);
  await db.update(sessions).set({ threadId, updatedAt: new Date() }).where(eq(sessions.id, sessionId));
  log.info({ sessionId, threadId }, "thread created");
  return threadId;
}
