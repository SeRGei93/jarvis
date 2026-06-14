import { describe, it, expect, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { buildCronScheduler } from "../../src/scheduler/wiring.js";
import type { ScheduleFn } from "../../src/scheduler/scheduler.js";
import type { Notifier } from "../../src/scheduler/executor.js";
import type { ChatService } from "../../src/app.js";
import type { SettingsService } from "../../src/config/settings.js";
import { users, sessions, cronTasks } from "../../src/db/schema.js";

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

/** Capture the registered cron callbacks so a tick can be fired by hand. */
function fakeSchedule() {
  const cbs: Record<string, () => Promise<void>> = {};
  const scheduleFn: ScheduleFn = (_expr, fn, options) => {
    cbs[options?.name ?? _expr] = fn as () => Promise<void>;
    return { stop: () => {} };
  };
  return { scheduleFn, cbs };
}

interface FakeSvc {
  svc: ChatService;
  handled: { userId: number; chatId: number; text: string }[];
}
function fakeChatService(replyText: string): FakeSvc {
  const handled: FakeSvc["handled"] = [];
  const svc = {
    deps: {
      db: t!.db,
      settings: {
        getTimeouts: async () => ({ llm_request: "300s", http_client: "300s", llm_activity: "30s" }),
      } as unknown as SettingsService,
      skills: { getPrompt: async () => "MONITORING" },
    },
    handleUserMessage: async (userId: number, chatId: number, text: string) => {
      handled.push({ userId, chatId, text });
      return { text: replyText, skills: ["research"], rejected: false };
    },
    close: async () => {},
  } as unknown as ChatService;
  return { svc, handled };
}

async function seedOnceTask(scheduledAt: Date): Promise<void> {
  await t!.db.insert(users).values({ id: 1, name: "u1" });
  const [s] = await t!.db
    .insert(sessions)
    .values({ chatId: 777, userId: 1, model: "test:model" })
    .returning({ id: sessions.id });
  await t!.db.insert(cronTasks).values({
    userId: 1,
    sessionId: s!.id,
    name: "reminder",
    prompt: "remind me",
    schedule: "once",
    scheduledAt,
    notificationChatId: 777,
  });
}

describe("buildCronScheduler — server wiring", () => {
  it("delivers a due task's result to the notifier via the wired chat pipeline", async () => {
    t = await createTestDb();
    await seedOnceTask(new Date(Date.now() - 60_000)); // due a minute ago

    const sent: { chatId: number; text: string }[] = [];
    const notifier: Notifier = { sendMessage: async (chatId, text) => void sent.push({ chatId, text }) };
    const { svc, handled } = fakeChatService("Готово, напоминание выполнено!");
    const { scheduleFn, cbs } = fakeSchedule();

    const scheduler = buildCronScheduler(svc, notifier, { scheduleFn });
    scheduler.start();
    await cbs["cron-scheduled"]!(); // fire the minute tick by hand

    // runTask was the wired handleUserMessage, bound to the task's user + chat.
    expect(handled).toEqual([{ userId: 1, chatId: 777, text: "remind me" }]);
    // The reply was delivered to the task's notification chat.
    expect(sent).toEqual([{ chatId: 777, text: "Готово, напоминание выполнено!" }]);
  });

  it("does not deliver anything when no task is due", async () => {
    t = await createTestDb();
    await seedOnceTask(new Date(Date.now() + 3_600_000)); // due in an hour

    const sent: { chatId: number; text: string }[] = [];
    const notifier: Notifier = { sendMessage: async (chatId, text) => void sent.push({ chatId, text }) };
    const { svc, handled } = fakeChatService("nope");
    const { scheduleFn, cbs } = fakeSchedule();

    const scheduler = buildCronScheduler(svc, notifier, { scheduleFn });
    scheduler.start();
    await cbs["cron-scheduled"]!();

    expect(handled).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});
