import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { LibSQLStore } from "@mastra/libsql";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import {
  resolveThreadId,
  rotateThread,
  threadIdForSession,
  resourceIdForUser,
  createConversationMemory,
  ensureThread,
  saveUserMessage,
  saveAssistant,
  getRecentMessages,
} from "../../src/mastra/memory/history.js";
import { users, sessions } from "../../src/db/schema.js";

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

describe("history helpers", () => {
  it("derives stable thread/resource ids", () => {
    expect(threadIdForSession(7)).toBe("session-7");
    expect(resourceIdForUser(42)).toBe("user:42");
  });

  it("resolveThreadId persists then reuses the thread id", async () => {
    t = await createTestDb();
    await t.db.insert(users).values({ id: 1, name: "u" });
    await t.db.insert(sessions).values({ id: 1, chatId: 100, userId: 1, model: "m" });

    expect(await resolveThreadId(t.db, 1)).toBe("session-1");
    const [s] = await t.db.select().from(sessions).where(eq(sessions.id, 1));
    expect(s?.threadId).toBe("session-1");
    expect(await resolveThreadId(t.db, 1)).toBe("session-1"); // reused, not regenerated
  });

  it("createConversationMemory builds a Memory instance", async () => {
    t = await createTestDb();
    const store = new LibSQLStore({ id: "test-history", url: t.url });
    expect(createConversationMemory(store, 15)).toBeDefined();
  });
});

describe("history message I/O", () => {
  it("saves user + assistant turns and reads them back with skill metadata", async () => {
    t = await createTestDb();
    const store = new LibSQLStore({ id: "test-history-io", url: t.url });
    const memory = createConversationMemory(store, 15);
    const threadId = threadIdForSession(1);
    const resourceId = resourceIdForUser(1);

    await ensureThread(memory, threadId, resourceId);
    await saveUserMessage(memory, threadId, resourceId, "hello");
    await saveAssistant(memory, threadId, resourceId, "hi there", "chat");

    const msgs = await getRecentMessages(memory, threadId, resourceId, 15);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs.map((m) => m.content)).toEqual(["hello", "hi there"]);
    expect(msgs[0]!.skill).toBeNull();
    expect(msgs[1]!.skill).toBe("chat");
  });

  it("ensureThread is idempotent", async () => {
    t = await createTestDb();
    const store = new LibSQLStore({ id: "test-history-idem", url: t.url });
    const memory = createConversationMemory(store, 15);
    const threadId = threadIdForSession(2);
    const resourceId = resourceIdForUser(2);

    await ensureThread(memory, threadId, resourceId);
    await ensureThread(memory, threadId, resourceId); // no throw on second call
    await saveUserMessage(memory, threadId, resourceId, "x");
    expect((await getRecentMessages(memory, threadId, resourceId, 15)).length).toBe(1);
  });

  it("rotateThread purges old messages, resets summary, returns a fresh thread id", async () => {
    t = await createTestDb();
    await t.db.insert(users).values({ id: 1, name: "u" });
    await t.db
      .insert(sessions)
      .values({ id: 1, chatId: 100, userId: 1, model: "m", threadId: "session-1", summary: "old", summaryMsgCount: 4 });

    const store = new LibSQLStore({ id: "test-rotate", url: t.url });
    const memory = createConversationMemory(store, 15);
    const resourceId = resourceIdForUser(1);
    await ensureThread(memory, "session-1", resourceId);
    await saveUserMessage(memory, "session-1", resourceId, "old message");
    expect((await getRecentMessages(memory, "session-1", resourceId, 15)).length).toBe(1);

    const newThreadId = await rotateThread(t.db, 1);
    expect(newThreadId).toMatch(/^session-1-/);
    expect(newThreadId).not.toBe("session-1");

    // old thread's messages are purged
    expect((await getRecentMessages(memory, "session-1", resourceId, 15)).length).toBe(0);

    // session points at the new thread and the rolling summary is reset
    const [s] = await t.db.select().from(sessions).where(eq(sessions.id, 1));
    expect(s?.threadId).toBe(newThreadId);
    expect(s?.summary).toBeNull();
    expect(s?.summaryMsgCount).toBe(0);
  });
});
