import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { SettingsService } from "../../src/config/settings.js";
import { SkillService } from "../../src/services/skill-service.js";
import { UsageService } from "../../src/services/usage.js";
import { MemoryService } from "../../src/mastra/memory/memory-service.js";
import { createBot } from "../../src/telegram/bot.js";
import { AccessRequestService } from "../../src/services/access-request-service.js";
import type { ChatHandler, CommandDeps } from "../../src/telegram/commands.js";
import type { FetchLike } from "../../src/telegram/voice.js";
import {
  users,
  userChannels,
  accessRequests,
  settings as settingsTable,
} from "../../src/db/schema.js";

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

function buildBot(
  t: TestDb,
  chat: ChatHandler,
  opts: { fetchFn?: FetchLike; filePath?: string } = {},
) {
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
    accessRequests: new AccessRequestService(t.db, settings),
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
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
      result = { file_id: "x", file_unique_id: "x", file_path: opts.filePath ?? "voice/f.ogg" };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { ok: true, result } as any;
  });

  return { bot, sent };
}

/** Fake image download — returns a tiny valid PNG signature (Mastra validates it). */
const imageFetch: FetchLike = async () => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).buffer,
});

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

function photoUpdate(fromId: number, caption?: string, chatId = 9000) {
  return {
    update_id: Math.floor(fromId + chatId + 1),
    message: {
      message_id: 11,
      date: 0,
      chat: { id: chatId, type: "private" },
      from: { id: fromId, is_bot: false, first_name: "Serg" },
      photo: [
        { file_id: "small", file_unique_id: "s", width: 90, height: 90, file_size: 1_000 },
        { file_id: "large", file_unique_id: "l", width: 800, height: 800, file_size: 9_000 },
      ],
      ...(caption !== undefined ? { caption } : {}),
    },
  };
}

function documentUpdate(
  fromId: number,
  doc: { file_id: string; file_name?: string; mime_type?: string; file_size?: number },
  chatId = 9000,
) {
  return {
    update_id: Math.floor(fromId + chatId + 2),
    message: {
      message_id: 12,
      date: 0,
      chat: { id: chatId, type: "private" },
      from: { id: fromId, is_bot: false, first_name: "Serg" },
      document: { file_unique_id: "u", ...doc },
    },
  };
}

function animationUpdate(fromId: number, mimeType: string, chatId = 9000) {
  return {
    update_id: Math.floor(fromId + chatId + 3),
    message: {
      message_id: 13,
      date: 0,
      chat: { id: chatId, type: "private" },
      from: { id: fromId, is_bot: false, first_name: "Serg" },
      animation: {
        file_id: "anim",
        file_unique_id: "u",
        width: 320,
        height: 240,
        duration: 2,
        mime_type: mimeType,
        file_size: 2_000,
      },
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

  it("approval mode: an unknown user gets a one-time 'request sent' reply + a pending request", async () => {
    t = await createTestDb();
    await t.db.insert(settingsTable).values({ key: "telegram_access_mode", value: "approval" });
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
    await bot.handleUpdate(textUpdate(555, "пустите меня") as any);

    expect(called).toBe(false);
    const reqs = await t.db.select().from(accessRequests).where(eq(accessRequests.tgUserId, 555));
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.status).toBe("pending");
    const sentRequestReply = () =>
      sent.filter(
        (c) =>
          c.method === "sendRichMessage" &&
          String(c.payload.rich_message?.markdown).includes("Заявка"),
      );
    expect(sentRequestReply()).toHaveLength(1);
    expect(await t.db.select().from(users)).toHaveLength(0);

    // A second message must NOT create a duplicate request or re-send the reply.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await bot.handleUpdate(textUpdate(555, "ну пожалуйста") as any);
    expect(await t.db.select().from(accessRequests).where(eq(accessRequests.tgUserId, 555))).toHaveLength(1);
    expect(sentRequestReply()).toHaveLength(1);
  });

  it("approval mode: an allowlisted user is handled normally", async () => {
    t = await createTestDb();
    await t.db.insert(settingsTable).values([
      { key: "telegram_access_mode", value: "approval" },
      { key: "telegram_allowed_users", value: [555] },
    ]);
    let received = "";
    const chat: ChatHandler = {
      handleUserMessage: async (_u, _c, text) => {
        received = text;
        return { text: "готово", skills: [], rejected: false };
      },
    };
    const { bot } = buildBot(t, chat);
    await bot.init();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await bot.handleUpdate(textUpdate(555, "привет") as any);
    expect(received).toBe("привет");
  });

  it("routes a photo update into the chat pipeline with image bytes and caption", async () => {
    t = await createTestDb();
    let receivedText = "";
    let receivedImages: unknown[] | undefined;
    const chat: ChatHandler = {
      handleUserMessage: async (_u, _c, text, _onText, _onTool, images) => {
        receivedText = text;
        receivedImages = images;
        return { text: "готово", skills: [], rejected: false };
      },
    };
    const { bot } = buildBot(t, chat, { fetchFn: imageFetch, filePath: "photos/f.jpg" });
    await bot.init();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await bot.handleUpdate(photoUpdate(555, "что на фото?") as any);

    expect(receivedText).toBe("что на фото?");
    expect(receivedImages).toHaveLength(1);
    expect((receivedImages![0] as { mediaType: string }).mediaType).toBe("image/jpeg");
  });

  it("refuses an animation without downloading or calling the model", async () => {
    t = await createTestDb();
    let called = false;
    const chat: ChatHandler = {
      handleUserMessage: async () => {
        called = true;
        return { text: "x", skills: [], rejected: false };
      },
    };
    const { bot, sent } = buildBot(t, chat, { fetchFn: imageFetch, filePath: "animations/f.gif" });
    await bot.init();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await bot.handleUpdate(animationUpdate(555, "image/gif") as any);

    expect(called).toBe(false);
    expect(sent.some((c) => c.method === "getFile")).toBe(false);
    expect(JSON.stringify(sent)).toContain("не умею");
  });

  it("refuses a PDF document without downloading or calling the model", async () => {
    t = await createTestDb();
    let called = false;
    const chat: ChatHandler = {
      handleUserMessage: async () => {
        called = true;
        return { text: "x", skills: [], rejected: false };
      },
    };
    const { bot, sent } = buildBot(t, chat, { fetchFn: imageFetch, filePath: "documents/f.pdf" });
    await bot.init();

    await bot.handleUpdate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      documentUpdate(555, { file_id: "pdf", file_name: "a.pdf", mime_type: "application/pdf", file_size: 1_000 }) as any,
    );

    expect(called).toBe(false);
    expect(sent.some((c) => c.method === "getFile")).toBe(false);
    expect(JSON.stringify(sent)).toContain("не умею");
  });

  it("refuses HEIC without downloading", async () => {
    t = await createTestDb();
    let called = false;
    const chat: ChatHandler = {
      handleUserMessage: async () => {
        called = true;
        return { text: "x", skills: [], rejected: false };
      },
    };
    const { bot, sent } = buildBot(t, chat, { fetchFn: imageFetch, filePath: "documents/f.heic" });
    await bot.init();

    await bot.handleUpdate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      documentUpdate(555, { file_id: "heic", file_name: "a.heic", mime_type: "image/heic", file_size: 1_000 }) as any,
    );

    expect(called).toBe(false);
    expect(sent.some((c) => c.method === "getFile")).toBe(false);
    expect(JSON.stringify(sent)).toContain("не поддерживается");
  });

  it("refuses a GIF document without downloading", async () => {
    t = await createTestDb();
    let called = false;
    const chat: ChatHandler = {
      handleUserMessage: async () => {
        called = true;
        return { text: "x", skills: [], rejected: false };
      },
    };
    const { bot, sent } = buildBot(t, chat, { fetchFn: imageFetch, filePath: "documents/f.gif" });
    await bot.init();

    await bot.handleUpdate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      documentUpdate(555, { file_id: "gif", file_name: "a.gif", mime_type: "image/gif", file_size: 1_000 }) as any,
    );

    expect(called).toBe(false);
    expect(sent.some((c) => c.method === "getFile")).toBe(false);
    expect(JSON.stringify(sent)).toContain("не поддерживается");
  });
});
