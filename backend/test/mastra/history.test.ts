import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { LibSQLStore } from "@mastra/libsql";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import {
  resolveThreadId,
  threadIdForSession,
  resourceIdForUser,
  createConversationMemory,
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
