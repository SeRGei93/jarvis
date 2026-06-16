import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { SettingsService } from "../../src/config/settings.js";
import { SkillService } from "../../src/services/skill-service.js";
import { UsageService } from "../../src/services/usage.js";
import { MemoryService } from "../../src/mastra/memory/memory-service.js";
import { createBot } from "../../src/telegram/bot.js";
import type { ChatHandler, CommandDeps } from "../../src/telegram/commands.js";
import { users, userChannels, settings as settingsTable } from "../../src/db/schema.js";

// Minimal UserFromGetMe so bot.init() skips the getMe network call.
const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: "Jarvis",
  username: "jarvis_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
} as const;

interface SentCall {
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
}

function buildBot(t: TestDb, chat: ChatHandler) {
  const settings = new SettingsService(t.db);
  const embedder = { generate: async () => new Array(1024).fill(0) };
  const commandDeps: CommandDeps = {
    db: t.db,
    settings,
    skills: new SkillService(),
    usage: new UsageService(t.db),
    memory: new MemoryService(t.db, t.vector, embedder, settings),
    chat,
  };
  const bot = createBot({
    token: "123456:TEST-token",
    db: t.db,
    settings,
    chat,
    speech: { transcribe: async () => "voice text" },
    commandDeps,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    botConfig: { botInfo: BOT_INFO as any },
  });

  const sent: SentCall[] = [];
  let nextId = 500;
  // Intercept all outgoing API calls — no network.
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload });
    let result: unknown = true;
    if (method === "sendMessage") {
      result = { message_id: nextId++, date: 0, chat: { id: payload.chat_id, type: "private" }, text: payload.text };
    } else if (method === "getFile") {
      result = { file_id: "x", file_unique_id: "x", file_path: "voice/f.ogg" };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { ok: true, result } as any;
  });

  return { bot, sent };
}

function textUpdate(fromId: number, text: string, chatId = 9000) {
  // Telegram marks slash-commands with a bot_command entity at offset 0.
  const entities = text.startsWith("/")
    ? [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0]!.length }]
    : undefined;
  return {
    update_id: Math.floor(fromId + chatId),
    message: {
      message_id: 10,
      date: 0,
      chat: { id: chatId, type: "private" },
      from: { id: fromId, is_bot: false, first_name: "Serg" },
      text,
      ...(entities ? { entities } : {}),
    },
  };
}

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

describe("bot integration (fake update, no network)", () => {
  it("routes a text message: creates the user and sends a streamed reply", async () => {
    t = await createTestDb();
    let received = "";
    const chat: ChatHandler = {
      handleUserMessage: async (_u, _c, text) => {
        received = text;
        return { text: "готово", skills: [], rejected: false };
      },
    };
    const { bot, sent } = buildBot(t, chat);
    await bot.init();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await bot.handleUpdate(textUpdate(555, "привет") as any);

    expect(received).toBe("привет");
    const [ch] = await t.db.select().from(userChannels).where(eq(userChannels.externalId, "555"));
    expect(ch).toBeTruthy();
    expect(
      sent.some((c) => c.method === "sendRichMessage" && String(c.payload.rich_message?.markdown).includes("готово")),
    ).toBe(true);
  });

  it("routes the /help command to a reply", async () => {
    t = await createTestDb();
    const chat: ChatHandler = { handleUserMessage: async () => ({ text: "x", skills: [], rejected: false }) };
    const { bot, sent } = buildBot(t, chat);
    await bot.init();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await bot.handleUpdate(textUpdate(555, "/help") as any);
    expect(
      sent.some((c) => c.method === "sendRichMessage" && String(c.payload.rich_message?.markdown).includes("Команды")),
    ).toBe(true);
  });

  it("drops an unauthorized user (allowlist) without creating a user or replying", async () => {
    t = await createTestDb();
    await t.db.insert(settingsTable).values({ key: "telegram_allowed_users", value: [999] });
    let called = false;
    const chat: ChatHandler = {
      handleUserMessage: async () => {
        called = true;
        return { text: "x", skills: [], rejected: false };
      },
    };
    const { bot, sent } = buildBot(t, chat);
    await bot.init();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await bot.handleUpdate(textUpdate(555, "привет") as any);

    expect(called).toBe(false);
    expect(sent.filter((c) => c.method === "sendMessage" || c.method === "sendRichMessage")).toHaveLength(0);
    expect(await t.db.select().from(users)).toHaveLength(0);
  });
});
