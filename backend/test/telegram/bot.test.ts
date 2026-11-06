import { describe, it, expect, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/libsql.js";
import { Messenger } from "../../src/telegram/messenger.js";
import {
  isAuthorized,
  processText,
  processVoice,
  processImage,
  UNSUPPORTED_REPLY,
  type BotRuntime,
} from "../../src/telegram/bot.js";
import { UNSUPPORTED_IMAGE_REPLY } from "../../src/telegram/image.js";
import { TelegramReplyError } from "../../src/telegram/errors.js";
import type { ChatHandler, CommandDeps } from "../../src/telegram/commands.js";
import type { FetchLike } from "../../src/telegram/voice.js";
import { users, userChannels } from "../../src/db/schema.js";

interface Call {
  op: "draft" | "send" | "action" | "getFile";
  text?: string;
  rich?: boolean;
}

class FakeApi {
  calls: Call[] = [];
  constructor(
    private readonly filePath = "voice/f.ogg",
    private readonly getFileError: Error | null = null,
  ) {}
  async sendRichMessageDraft(_c: number, _draftId: number, richMessage: { markdown: string }) {
    this.calls.push({ op: "draft", text: richMessage.markdown, rich: true });
    return {};
  }
  async sendRichMessage(_c: number, richMessage: { markdown: string }) {
    this.calls.push({ op: "send", text: richMessage.markdown, rich: true });
    return {};
  }
  async sendMessage(_c: number, text: string) {
    this.calls.push({ op: "send", text, rich: false });
    return {};
  }
  async sendChatAction(_c: number, _a: "typing") {
    this.calls.push({ op: "action" });
    return {};
  }
  async getFile(_fileId: string) {
    this.calls.push({ op: "getFile" });
    if (this.getFileError) throw this.getFileError;
    return { file_path: this.filePath };
  }
}

const okFetch: FetchLike = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });

function makeRuntime(
  t: TestDb,
  chat: ChatHandler,
  speechText = "распознанный текст",
  adminUserIds: number[] = [],
  api: FakeApi = new FakeApi(),
): { rt: BotRuntime; api: FakeApi } {
  const rt: BotRuntime = {
    api,
    db: t.db,
    chat,
    speech: { transcribe: async () => speechText },
    messenger: new Messenger(api),
    token: "TKN",
    fetchFn: okFetch,
    commandDeps: {} as unknown as CommandDeps, // unused by processText/processVoice
    adminUserIds,
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

    await processText(rt, { id: 555, name: "Serg" }, 42, "hello", 1);

    // user + channel created
    const [ch] = await t.db.select().from(userChannels).where(eq(userChannels.externalId, "555"));
    expect(ch).toBeTruthy();
    expect(received).toMatchObject({ chatId: 42, text: "hello", userId: ch!.userId });

    // reply was finalized as a rich message (markdown passed through verbatim)
    expect(api.calls.some((c) => c.rich && (c.text ?? "").includes("**Привет**"))).toBe(true);
  });

  it("still sends the reply when promptguard/rate-limit rejected (no streaming)", async () => {
    t = await createTestDb();
    const chat: ChatHandler = {
      handleUserMessage: async () => ({ text: "Слишком длинное сообщение.", skills: [], rejected: true }),
    };
    const { rt, api } = makeRuntime(t, chat);

    await processText(rt, { id: 7, name: "X" }, 9, "x".repeat(99), 2);
    const sends = api.calls.filter((c) => c.op === "send" && c.rich);
    expect(sends.some((c) => (c.text ?? "").includes("Слишком длинное"))).toBe(true);
  });

  it("shows the debug overlay to an admin — gated on the Telegram id, not the internal users.id", async () => {
    t = await createTestDb();
    const chat: ChatHandler = {
      handleUserMessage: async (_u, _c, _text, onText, onTool) => {
        onTool?.onStart?.("web_search", { query: "курс" }); // first set* → flushes immediately
        await tick();
        onTool?.onReasoning?.("прикидываю"); // throttled in the draft, but kept for finalize
        onTool?.onFinish?.("web_search", false);
        onText?.("готово");
        await tick();
        return { text: "готово", skills: [], rejected: false };
      },
    };
    // Telegram id 555; the created user's internal id is 1 — the gate must use 555.
    const { rt, api } = makeRuntime(t, chat, undefined, [555]);

    await processText(rt, { id: 555, name: "Serg" }, 42, "новости", 1);

    const drafts = api.calls.filter((c) => c.op === "draft").map((c) => c.text ?? "");
    expect(drafts[0]).toContain("🔧 web_search(query=курс)"); // live tool trace
    const finalSend = api.calls.find((c) => c.op === "send" && c.rich);
    expect(finalSend?.text).toContain("<details><summary>🧠 Рассуждения</summary>"); // reasoning persists
    expect(finalSend?.text).toContain("прикидываю");
    expect(finalSend?.text).toContain("🔧 web_search(query=курс)"); // tool trace persists too
  });

  it("shows no debug overlay to a non-admin", async () => {
    t = await createTestDb();
    const chat: ChatHandler = {
      handleUserMessage: async (_u, _c, _text, onText, onTool) => {
        onTool?.onReasoning?.("прикидываю"); // onReasoning is undefined for non-admins → no-op
        onTool?.onStart?.("web_search", { query: "курс" });
        await tick();
        onText?.("готово");
        await tick();
        return { text: "готово", skills: [], rejected: false };
      },
    };
    const { rt, api } = makeRuntime(t, chat, undefined, []); // not an admin

    await processText(rt, { id: 555, name: "Serg" }, 42, "новости", 1);

    const blob = api.calls.map((c) => c.text ?? "").join("\n");
    expect(blob).not.toContain("<tg-thinking>");
    expect(blob).not.toContain("🔧");
    expect(blob).not.toContain("<details>");
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

    await processVoice(rt, { id: 8, name: "V" }, 21, "file-1", 5, 3);
    expect(receivedText).toBe("погода завтра");
  });

  it("throws TelegramReplyError for an over-long voice message", async () => {
    t = await createTestDb();
    const chat: ChatHandler = { handleUserMessage: async () => ({ text: "x", skills: [], rejected: false }) };
    const { rt } = makeRuntime(t, chat);
    await expect(processVoice(rt, { id: 8 }, 21, "file-1", 31, 4)).rejects.toBeInstanceOf(TelegramReplyError);
  });
});

describe("processImage", () => {
  function capturingChat() {
    const received: { text: string; images?: { data: Uint8Array; mediaType: string }[] } = { text: "" };
    const chat: ChatHandler = {
      handleUserMessage: async (_u, _c, text, _onText, _onTool, images) => {
        received.text = text;
        received.images = images;
        return { text: "ответ", skills: [], rejected: false };
      },
    };
    return { chat, received };
  }

  const photoSizes = [
    { file_id: "small", width: 90, height: 90, file_size: 1_000 },
    { file_id: "large", width: 800, height: 800, file_size: 9_000 },
  ];

  it("downloads the largest photo and feeds bytes + caption into the chat pipeline", async () => {
    t = await createTestDb();
    const { chat, received } = capturingChat();
    const api = new FakeApi("photos/f.jpg");
    const { rt } = makeRuntime(t, chat, undefined, [], api);

    const res = await processImage(rt, { id: 555, name: "S" }, 42, { kind: "photo", sizes: photoSizes }, "  что здесь?  ", 7);

    expect(res.rejected).toBe(false);
    expect(received.text).toBe("что здесь?");
    expect(received.images).toHaveLength(1);
    expect(received.images![0]!.mediaType).toBe("image/jpeg");
    expect(received.images![0]!.data).toBeInstanceOf(Uint8Array);
    expect(api.calls.filter((c) => c.op === "getFile")).toHaveLength(1);
  });

  it("passes an empty caption through for a photo without text", async () => {
    t = await createTestDb();
    const { chat, received } = capturingChat();
    const { rt } = makeRuntime(t, chat, undefined, [], new FakeApi("photos/f.jpg"));

    await processImage(rt, { id: 555 }, 42, { kind: "photo", sizes: photoSizes }, "", 7);

    expect(received.text).toBe("");
    expect(received.images).toHaveLength(1);
  });

  it("accepts an image document using its MIME hint", async () => {
    t = await createTestDb();
    const { chat, received } = capturingChat();
    const { rt } = makeRuntime(t, chat, undefined, [], new FakeApi("documents/f"));

    await processImage(
      rt,
      { id: 555 },
      42,
      { kind: "document", fileId: "fid", mimeType: "image/png", fileName: "pic.png", fileSize: 1_000 },
      "подпись",
      7,
    );

    expect(received.images![0]!.mediaType).toBe("image/png");
  });

  it("refuses a PDF without downloading", async () => {
    t = await createTestDb();
    const { chat } = capturingChat();
    const { rt, api } = makeRuntime(t, chat);

    const res = await processImage(
      rt,
      { id: 555 },
      42,
      { kind: "document", fileId: "fid", mimeType: "application/pdf", fileName: "a.pdf", fileSize: 1_000 },
      "",
      7,
    );

    expect(res).toEqual({ text: UNSUPPORTED_REPLY, skills: [], rejected: true });
    expect(api.calls.some((c) => c.op === "getFile")).toBe(false);
    expect(api.calls.some((c) => c.text === UNSUPPORTED_REPLY)).toBe(true);
  });

  it("refuses HEIC without downloading", async () => {
    t = await createTestDb();
    const { chat } = capturingChat();
    const { rt, api } = makeRuntime(t, chat);

    const res = await processImage(
      rt,
      { id: 555 },
      42,
      { kind: "document", fileId: "fid", mimeType: "image/heic", fileName: "a.heic", fileSize: 1_000 },
      "",
      7,
    );

    expect(res).toEqual({ text: UNSUPPORTED_IMAGE_REPLY, skills: [], rejected: true });
    expect(api.calls.some((c) => c.op === "getFile")).toBe(false);
  });

  it("refuses an oversized document before downloading", async () => {
    t = await createTestDb();
    const { chat } = capturingChat();
    const { rt, api } = makeRuntime(t, chat);

    const res = await processImage(
      rt,
      { id: 555 },
      42,
      { kind: "document", fileId: "fid", mimeType: "image/png", fileName: "big.png", fileSize: 11 * 1024 * 1024 },
      "",
      7,
    );

    expect(res.rejected).toBe(true);
    expect(api.calls.some((c) => c.op === "getFile")).toBe(false);
  });

  it("surfaces a getFile failure as TelegramReplyError", async () => {
    t = await createTestDb();
    const { chat } = capturingChat();
    const { rt } = makeRuntime(t, chat, undefined, [], new FakeApi("photos/f.jpg", new Error("telegram down")));

    await expect(
      processImage(rt, { id: 555 }, 42, { kind: "photo", sizes: photoSizes }, "", 7),
    ).rejects.toBeInstanceOf(TelegramReplyError);
  });
});
