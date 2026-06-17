import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { RollingSummaryService, type Summarizer } from "../../src/mastra/memory/rolling-summary.js";
import { users, sessions } from "../../src/db/schema.js";
import type { Message } from "../../src/domain/entities.js";

/** Build `n` alternating user/assistant messages (m0, m1, ...). */
function msgs(n: number): Message[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `m${i}`,
  }));
}

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

async function setup(summarizer: Summarizer): Promise<RollingSummaryService> {
  t = await createTestDb();
  await t.db.insert(users).values({ id: 1, name: "u" });
  await t.db.insert(sessions).values({ id: 1, chatId: 100, userId: 1, model: "m" });
  return new RollingSummaryService(t.db, summarizer);
}

describe("RollingSummaryService", () => {
  it("returns null when nothing is evicted (total <= window)", async () => {
    const svc = await setup({ summarize: async () => "X" });
    const r = await svc.maybeUpdate({
      sessionId: 1,
      allMessages: msgs(10),
      windowSize: 50,
      currentSummary: null,
      currentCount: 0,
    });
    expect(r).toBeNull();
  });

  it("folds newly-evicted messages and persists summary + count", async () => {
    const seen: Message[][] = [];
    const svc = await setup({
      summarize: async (prev, next) => {
        seen.push(next);
        return `${prev}|${next.map((m) => m.content).join(",")}`;
      },
    });
    // 12 messages, window 4 -> 8 beyond the window (m0..m7)
    const r = await svc.maybeUpdate({
      sessionId: 1,
      allMessages: msgs(12),
      windowSize: 4,
      currentSummary: null,
      currentCount: 0,
    });
    expect(r).not.toBeNull();
    expect(r!.count).toBe(8);
    expect(seen[0]).toHaveLength(8);
    const [row] = await t!.db.select().from(sessions).where(eq(sessions.id, 1));
    expect(row!.summaryMsgCount).toBe(8);
    expect(row!.summary).toContain("m0");
  });

  it("only folds the new slice on a subsequent call", async () => {
    const seen: Message[][] = [];
    const svc = await setup({
      summarize: async (prev, next) => {
        seen.push(next);
        return `${prev}+${next.length}`;
      },
    });
    // 8 already covered; now 16 messages, window 4 -> evicted 12, fold slice [8,12)
    const r = await svc.maybeUpdate({
      sessionId: 1,
      allMessages: msgs(16),
      windowSize: 4,
      currentSummary: "S",
      currentCount: 8,
    });
    expect(r!.count).toBe(12);
    expect(seen[0]).toHaveLength(4);
  });

  it("fail-open: a summarizer error returns null and leaves the session unchanged", async () => {
    const svc = await setup({
      summarize: async () => {
        throw new Error("boom");
      },
    });
    const r = await svc.maybeUpdate({
      sessionId: 1,
      allMessages: msgs(12),
      windowSize: 4,
      currentSummary: null,
      currentCount: 0,
    });
    expect(r).toBeNull();
    const [row] = await t!.db.select().from(sessions).where(eq(sessions.id, 1));
    expect(row!.summary).toBeNull();
    expect(row!.summaryMsgCount).toBe(0);
  });
});
