import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { SettingsService } from "../../src/config/settings.js";
import { SkillService } from "../../src/services/skill-service.js";
import { UsageService } from "../../src/services/usage.js";
import { MemoryService } from "../../src/mastra/memory/memory-service.js";
import {
  cmdStart,
  cmdNew,
  cmdMe,
  cmdTasks,
  cmdUsage,
  cmdAbout,
  cmdResetOnboarding,
  type CommandDeps,
  type ChatHandler,
} from "../../src/telegram/commands.js";
import { users, sessions, memories, cronTasks, prompts } from "../../src/db/schema.js";

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

const fakeChat: ChatHandler = {
  handleUserMessage: async (_u, _c, text) => ({ text: `echo:${text}`, skills: [], rejected: false }),
};

function makeDeps(db: TestDb, chat: ChatHandler = fakeChat): CommandDeps {
  const settings = new SettingsService(db.db);
  const embedder = { generate: async () => new Array(1024).fill(0) };
  return {
    db: db.db,
    settings,
    skills: new SkillService(db.db),
    usage: new UsageService(db.db),
    memory: new MemoryService(db.db, db.vector, embedder, settings),
    chat,
  };
}

async function makeUser(db: TestDb["db"], onboarded = true): Promise<number> {
  const [u] = await db.insert(users).values({ name: "tester", onboarded }).returning({ id: users.id });
  return u!.id;
}
async function makeSession(db: TestDb["db"], chatId: number, userId: number): Promise<number> {
  const [s] = await db
    .insert(sessions)
    .values({ chatId, userId, model: "openrouter:x", threadId: `session-pre` })
    .returning({ id: sessions.id });
  return s!.id;
}

describe("commands", () => {
  it("/start returns the WELCOME prompt body", async () => {
    t = await createTestDb();
    await t.db.insert(prompts).values({ key: "WELCOME", body: "Здравствуйте!" });
    expect(await cmdStart(makeDeps(t))).toBe("Здравствуйте!");
  });

  it("/new rotates the thread and clears session memories but keeps permanent ones", async () => {
    t = await createTestDb();
    const userId = await makeUser(t.db);
    const chatId = 9001;
    const sessionId = await makeSession(t.db, chatId, userId);

    await t.db.insert(memories).values([
      { userId, category: "fact", scope: "session", sessionId, content: "session fact" },
      { userId, category: "preference", scope: "permanent", content: "permanent fact" },
    ]);

    const reply = await cmdNew(makeDeps(t), userId, chatId);
    expect(reply).toContain("новую сессию");

    const remaining = await t.db.select().from(memories).where(eq(memories.userId, userId));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.scope).toBe("permanent");

    const [s] = await t.db.select().from(sessions).where(eq(sessions.id, sessionId));
    expect(s!.threadId).not.toBe("session-pre"); // rotated
  });

  it("/me reports the profile and channel count", async () => {
    t = await createTestDb();
    const userId = await makeUser(t.db);
    const out = await cmdMe(makeDeps(t), userId);
    expect(out).toContain("Ваш профиль");
    expect(out).toContain("Онбординг: пройден");
    expect(out).toContain("Каналов: 0");
  });

  it("/tasks lists own tasks and refuses to delete another user's task", async () => {
    t = await createTestDb();
    const me = await makeUser(t.db);
    const other = await makeUser(t.db);
    const mySession = await makeSession(t.db, 1, me);
    const otherSession = await makeSession(t.db, 2, other);

    const [mine] = await t.db
      .insert(cronTasks)
      .values({ userId: me, sessionId: mySession, name: "моя задача", schedule: "0 9 * * *" })
      .returning({ id: cronTasks.id });
    const [theirs] = await t.db
      .insert(cronTasks)
      .values({ userId: other, sessionId: otherSession, name: "чужая", schedule: "0 9 * * *" })
      .returning({ id: cronTasks.id });

    const deps = makeDeps(t);
    const list = await cmdTasks(deps, me, "");
    expect(list).toContain("моя задача");
    expect(list).not.toContain("чужая");

    // Cannot delete another user's task.
    expect(await cmdTasks(deps, me, String(theirs!.id))).toBe("Задача не найдена.");
    const [stillThere] = await t.db.select().from(cronTasks).where(eq(cronTasks.id, theirs!.id));
    expect(stillThere).toBeTruthy();

    // Can delete own.
    expect(await cmdTasks(deps, me, String(mine!.id))).toContain("удалена");
  });

  it("/usage aggregates over the recent window and excludes old dates", async () => {
    t = await createTestDb();
    const userId = await makeUser(t.db);
    const usage = new UsageService(t.db);
    const today = new Date().toISOString().slice(0, 10);

    await usage.recordUsage(userId, 0.1, 1, today);
    await usage.recordUsage(userId, 0.1, 1, today);
    await usage.recordUsage(userId, 9.99, 1, "2000-01-01"); // far outside the window

    const out = await cmdUsage(makeDeps(t), userId, "30");
    expect(out).toContain("Запросов: 2");
    expect(out).toContain("$0.2000");
  });

  it("/about runs a fixed prompt through the chat pipeline", async () => {
    t = await createTestDb();
    const userId = await makeUser(t.db);
    expect(await cmdAbout(makeDeps(t), userId, 1)).toBe("echo:Что ты умеешь?");
  });

  it("/reset_onboarding clears the flag and greets through the pipeline", async () => {
    t = await createTestDb();
    const userId = await makeUser(t.db, true);
    const reply = await cmdResetOnboarding(makeDeps(t), userId, 1);
    expect(reply).toBe("echo:Привет!");
    const [u] = await t.db.select().from(users).where(eq(users.id, userId));
    expect(u!.onboarded).toBe(false);
  });
});
