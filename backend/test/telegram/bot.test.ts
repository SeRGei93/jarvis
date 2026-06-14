import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { Messenger } from "../../src/telegram/messenger.js";
import {
  isAuthorized,
  processText,
  processVoice,
  type BotRuntime,
} from "../../src/telegram/bot.js";
import { TelegramReplyError } from "../../src/telegram/errors.js";
import type { ChatHandler, CommandDeps } from "../../src/telegram/commands.js";
import type { FetchLike } from "../../src/telegram/voice.js";
import { users, userChannels } from "../../src/db/schema.js";

interface Call {
  op: "send" | "edit" | "action" | "getFile";
  text?: string;
  parse?: string;
}

class FakeApi {
  calls: Call[] = [];
  nextId = 100;
  async sendMessage(_c: number, text: string, other?: { parse_mode?: "MarkdownV2" }) {
    this.calls.push({ op: "send", text, parse: other?.parse_mode });
    return { message_id: this.nextId++ };
  }
  async editMessageText(_c: number, _m: number, text: string, other?: { parse_mode?: "MarkdownV2" }) {
    this.calls.push({ op: "edit", text, parse: other?.parse_mode });
    return true;
  }
  async sendChatAction(_c: number, _a: "typing") {
    this.calls.push({ op: "action" });
    return {};
  }
  async getFile(_fileId: string) {
    this.calls.push({ op: "getFile" });
    return { file_path: "voice/f.ogg" };
  }
}

const okFetch: FetchLike = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });

function makeRuntime(
  t: TestDb,
  chat: ChatHandler,
  speechText = "распознанный текст",
): { rt: BotRuntime; api: FakeApi } {
  const api = new FakeApi();
  const rt: BotRuntime = {
    api,
    db: t.db,
    chat,
    speech: { transcribe: async () => speechText },
    messenger: new Messenger(api),
    token: "TKN",
    fetchFn: okFetch,
    commandDeps: {} as unknown as CommandDeps, // unused by processText/processVoice
  };
  return { rt, api };
}

const tick = () => new Promise((r) => setImmediate(r));

let t: TestDb | undefined;
afterEach(() => {
  t?.cleanup();
  t = undefined;
});

describe("isAuthorized", () => {
  const settings = (ids: number[]) => ({ refreshIfStale: async () => {}, getAllowedUsers: async () => ids });

  it("allows everyone when the allowlist is empty", async () => {
    expect(await isAuthorized(settings([]), 555)).toBe(true);
  });
  it("allows only listed ids when the allowlist is non-empty", async () => {
    expect(await isAuthorized(settings([111]), 111)).toBe(true);
    expect(await isAuthorized(settings([111]), 222)).toBe(false);
  });
  it("rejects an undefined user", async () => {
    expect(await isAuthorized(settings([]), undefined)).toBe(false);
  });
});

describe("processText", () => {
  it("creates the user, streams, and sends the formatted reply", async () => {
    t = await createTestDb();
    let received: { userId: number; chatId: number; text: string } | undefined;
    const chat: ChatHandler = {
      handleUserMessage: async (userId, chatId, text, onText) => {
        received = { userId, chatId, text };
        onText?.("partial");
        await tick(); // let the first streamed chunk flush (sets message id)
        return { text: "**Привет**, мир", skills: ["research"], rejected: false };
      },
    };
    const { rt, api } = makeRuntime(t, chat);

    await processText(rt, { id: 555, name: "Serg" }, 42, "hello");

    // user + channel created
    const [ch] = await t.db.select().from(userChannels).where(eq(userChannels.externalId, "555"));
    expect(ch).toBeTruthy();
    expect(received).toMatchObject({ chatId: 42, text: "hello", userId: ch!.userId });

    // reply was finalized as MarkdownV2 ('**Привет**' -> '*Привет*')
    expect(api.calls.some((c) => c.parse === "MarkdownV2" && (c.text ?? "").includes("*Привет*"))).toBe(true);
  });

  it("still sends the reply when promptguard/rate-limit rejected (no streaming)", async () => {
    t = await createTestDb();
    const chat: ChatHandler = {
      handleUserMessage: async () => ({ text: "Слишком длинное сообщение.", skills: [], rejected: true }),
    };
    const { rt, api } = makeRuntime(t, chat);

    await processText(rt, { id: 7, name: "X" }, 9, "x".repeat(99));
    const sends = api.calls.filter((c) => c.op === "send" && c.parse === "MarkdownV2");
    expect(sends.some((c) => (c.text ?? "").includes("Слишком длинное"))).toBe(true);
  });
});

describe("processVoice", () => {
  it("transcribes then feeds the text into the chat pipeline", async () => {
    t = await createTestDb();
    let receivedText = "";
    const chat: ChatHandler = {
      handleUserMessage: async (_u, _c, text) => {
        receivedText = text;
        return { text: "ответ", skills: [], rejected: false };
      },
    };
    const { rt } = makeRuntime(t, chat, "погода завтра");

    await processVoice(rt, { id: 8, name: "V" }, 21, "file-1", 5);
    expect(receivedText).toBe("погода завтра");
  });

  it("throws TelegramReplyError for an over-long voice message", async () => {
    t = await createTestDb();
    const chat: ChatHandler = { handleUserMessage: async () => ({ text: "x", skills: [], rejected: false }) };
    const { rt } = makeRuntime(t, chat);
    await expect(processVoice(rt, { id: 8 }, 21, "file-1", 31)).rejects.toBeInstanceOf(TelegramReplyError);
  });
});
