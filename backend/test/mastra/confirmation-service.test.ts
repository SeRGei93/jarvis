import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { MemoryService } from "../../src/mastra/memory/memory-service.js";
import type { DedupChecker } from "../../src/mastra/memory/dedup.js";
import { ConfirmationService } from "../../src/mastra/confirmations/confirmation-service.js";
import { users, cronTasks, sessions } from "../../src/db/schema.js";

const dedup: DedupChecker = { isDuplicate: async () => false };

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

async function setup() {
  t = await createTestDb();
  await t.db.insert(users).values([
    { id: 1, name: "u1" },
    { id: 2, name: "u2" },
  ]);
  const mem = new MemoryService(t.db, dedup);
  const svc = new ConfirmationService(t.db, mem);
  return { db: t.db, mem, svc };
}

describe("ConfirmationService", () => {
  it("knows which tools require confirmation", async () => {
    const { svc } = await setup();
    expect(svc.requiresConfirmation("forget")).toBe(true);
    expect(svc.requiresConfirmation("task_delete")).toBe(true);
    expect(svc.requiresConfirmation("web_search")).toBe(false);
  });

  it("create → listPending surfaces the request; approve runs the executor (forget)", async () => {
    const { mem, svc } = await setup();
    const saved = await mem.save(1, "fact", "secret", null, "permanent");
    const memId = saved.saved ? saved.id : 0;

    const req = await svc.create({
      userId: 1,
      chatId: 10,
      sessionId: null,
      toolName: "forget",
      args: { memory_id: memId },
      summary: "delete?",
    });
    expect(req.toolName).toBe("forget");

    const pending = await svc.listPending(1, null);
    expect(pending.map((p) => p.id)).toContain(req.id);

    const res = await svc.resolve(1, req.id, true);
    expect(res.ok).toBe(true);
    expect(await mem.listPermanent(1)).toHaveLength(0); // actually deleted
    // No longer pending after resolution.
    expect(await svc.listPending(1, null)).toHaveLength(0);
  });

  it("decline leaves the action un-executed", async () => {
    const { mem, svc } = await setup();
    const saved = await mem.save(1, "fact", "keep me", null, "permanent");
    const memId = saved.saved ? saved.id : 0;
    const req = await svc.create({ userId: 1, chatId: 10, sessionId: null, toolName: "forget", args: { memory_id: memId }, summary: "x" });

    const res = await svc.resolve(1, req.id, false);
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/Отменено/);
    expect(await mem.listPermanent(1)).toHaveLength(1); // untouched
  });

  it("executes task_delete on approval", async () => {
    const { db, svc } = await setup();
    const [session] = await db.insert(sessions).values({ chatId: 10, userId: 1, model: "" }).returning();
    const [task] = await db
      .insert(cronTasks)
      .values({ userId: 1, sessionId: session!.id, name: "t", schedule: "now", notificationChatId: 10 })
      .returning();
    const req = await svc.create({ userId: 1, chatId: 10, sessionId: null, toolName: "task_delete", args: { task_id: task!.id }, summary: "x" });

    await svc.resolve(1, req.id, true);
    const rows = await db.select().from(cronTasks).where(eq(cronTasks.id, task!.id));
    expect(rows).toHaveLength(0);
  });

  it("is scoped by userId — another user cannot resolve it", async () => {
    const { svc } = await setup();
    const req = await svc.create({ userId: 1, chatId: 10, sessionId: null, toolName: "forget", args: { memory_id: 999 }, summary: "x" });
    const res = await svc.resolve(2, req.id, true); // user 2 tries
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/не найден/i);
  });

  it("is idempotent — a resolved confirmation cannot be resolved again", async () => {
    const { svc } = await setup();
    const req = await svc.create({ userId: 1, chatId: 10, sessionId: null, toolName: "forget", args: { memory_id: 999 }, summary: "x" });
    await svc.resolve(1, req.id, false);
    const second = await svc.resolve(1, req.id, true);
    expect(second.ok).toBe(false);
    expect(second.message).toMatch(/уже обработан/i);
  });
});
