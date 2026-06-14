import { randomUUID } from "node:crypto";
import { Memory } from "@mastra/memory";
import type { MastraDBMessage } from "@mastra/core/agent/message-list";
import type { LibSQLStore } from "@mastra/libsql";
import { eq } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../../db/schema.js";
import { sessions } from "../../db/schema.js";
import type { Message, MessageRole } from "../../domain/entities.js";
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

// ══════════════════════════════════════════════════════════════════════════
// Message I/O over Mastra Memory (mastra_threads / mastra_messages).
// Assistant replies carry their producing skill in content.metadata.skill so
// the router can derive previousSkills. Plaintext — no encryption (ROADMAP §6).
// ══════════════════════════════════════════════════════════════════════════

/** Ensure the Mastra thread row exists before messages are written to it. */
export async function ensureThread(memory: Memory, threadId: string, resourceId: string): Promise<void> {
  const existing = await memory.getThreadById({ threadId, resourceId });
  if (existing) return;
  await memory.createThread({ threadId, resourceId });
  log.debug({ threadId, resourceId }, "thread created in mastra memory");
}

function buildDbMessage(
  role: "user" | "assistant",
  text: string,
  threadId: string,
  resourceId: string,
  skill?: string | null,
): MastraDBMessage {
  return {
    id: randomUUID(),
    role,
    createdAt: new Date(),
    threadId,
    resourceId,
    content: {
      format: 2,
      parts: [{ type: "text", text }],
      content: text,
      ...(skill ? { metadata: { skill } } : {}),
    },
  };
}

/** Persist a user turn. */
export async function saveUserMessage(
  memory: Memory,
  threadId: string,
  resourceId: string,
  text: string,
): Promise<void> {
  await memory.saveMessages({ messages: [buildDbMessage("user", text, threadId, resourceId)] });
  log.debug({ threadId, role: "user" }, "message saved");
}

/** Persist an assistant turn, tagging the producing skill in metadata. */
export async function saveAssistant(
  memory: Memory,
  threadId: string,
  resourceId: string,
  text: string,
  skill?: string | null,
): Promise<void> {
  await memory.saveMessages({ messages: [buildDbMessage("assistant", text, threadId, resourceId, skill)] });
  log.debug({ threadId, role: "assistant", skill: skill ?? null }, "message saved");
}

/** Extract plain text from a Mastra message content (string content or joined text parts). */
function extractText(content: MastraDBMessage["content"]): string {
  if (typeof content.content === "string" && content.content) return content.content;
  return content.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("");
}

/**
 * Read the most recent `limit` messages of a thread as domain Messages, in
 * chronological order, with `skill` populated from assistant metadata.
 */
export async function getRecentMessages(
  memory: Memory,
  threadId: string,
  resourceId: string,
  limit: number,
): Promise<Message[]> {
  // recall returns messages in chronological (ASC) order and ignores an orderBy
  // override, so the newest `limit` are taken with slice(-limit). NOTE: this reads
  // the whole thread per turn; for very long-lived threads switch to a bounded
  // newest-first store query once the libSQL store exposes a reliable one.
  const { messages } = await memory.recall({ threadId, resourceId, perPage: false });
  const mapped: Message[] = messages
    .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system")
    .map((m) => ({
      role: m.role as MessageRole,
      content: extractText(m.content),
      skill: (m.content.metadata?.skill as string | undefined) ?? null,
      createdAt: m.createdAt,
    }));
  const recent = limit > 0 ? mapped.slice(-limit) : mapped;
  log.debug({ threadId, total: mapped.length, returned: recent.length }, "recent messages read");
  return recent;
}
