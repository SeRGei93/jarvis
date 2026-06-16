import { describe, it, expect, beforeEach } from "vitest";
import { createStreamer, STREAM_CURSOR, type TelegramSender } from "../../src/telegram/stream.js";

interface Call {
  op: "send" | "edit";
  text: string;
  rich: boolean;
  messageId?: number;
}

/** Coerce string | {markdown} into [text, isRich]. */
function content(c: string | { markdown: string }): [string, boolean] {
  return typeof c === "string" ? [c, false] : [c.markdown, true];
}

class FakeApi implements TelegramSender {
  calls: Call[] = [];
  nextId = 100;
  failRich = false;

  async sendMessage(_chatId: number, text: string) {
    this.calls.push({ op: "send", text, rich: false });
    return { message_id: this.nextId++ };
  }
  async editMessageText(_chatId: number, messageId: number, c: string | { markdown: string }) {
    const [text, rich] = content(c);
    this.calls.push({ op: "edit", text, rich, messageId });
    if (rich && this.failRich) throw new Error("can't parse rich");
    return true;
  }
  async sendRichMessage(_chatId: number, richMessage: { markdown: string }) {
    this.calls.push({ op: "send", text: richMessage.markdown, rich: true });
    if (this.failRich) throw new Error("can't parse rich");
    return {};
  }
}

/** Drain pending microtasks/promises scheduled by the fire-and-forget flush. */
const tick = () => new Promise((r) => setImmediate(r));

let api: FakeApi;
let clock: number;
beforeEach(() => {
  api = new FakeApi();
  clock = 0;
});

describe("createStreamer — streaming", () => {
  it("sends the first chunk (plain), then edits subsequent chunks (accumulated + cursor)", async () => {
    const s = createStreamer(api, 42, { now: () => clock, throttleMs: 1000 });

    s.onText("hello");
    await tick();
    expect(api.calls[0]).toMatchObject({ op: "send", text: "hello" + STREAM_CURSOR, rich: false });

    clock = 1000;
    s.onText("hello world");
    await tick();
    expect(api.calls[1]).toMatchObject({
      op: "edit",
      text: "hello world" + STREAM_CURSOR,
      rich: false,
      messageId: 100,
    });
  });

  it("throttles edits within the window", async () => {
    const s = createStreamer(api, 42, { now: () => clock, throttleMs: 1000 });

    s.onText("a");
    await tick(); // first send (no throttle)
    clock = 500;
    s.onText("ab");
    await tick(); // 500 < 1000 -> skipped
    expect(api.calls).toHaveLength(1);

    clock = 1000;
    s.onText("abc");
    await tick();
    expect(api.calls).toHaveLength(2);
  });

  it("skips a chunk that exceeds the plain-text guard", async () => {
    const s = createStreamer(api, 42, { now: () => clock });
    s.onText("x".repeat(4000));
    await tick();
    expect(api.calls).toHaveLength(0);
  });

  it("skips a chunk ending in an incomplete link", async () => {
    const s = createStreamer(api, 42, { now: () => clock });
    s.onText("see [docs");
    await tick();
    expect(api.calls).toHaveLength(0);

    s.onText("see [docs](http://e.com)");
    await tick();
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.op).toBe("send");
  });

  it("stops the typing indicator once, on the first chunk", async () => {
    let firstCount = 0;
    const s = createStreamer(api, 42, { now: () => clock, onFirstChunk: () => firstCount++ });
    s.onText("x");
    await tick();
    clock = 99999;
    s.onText("xy");
    await tick();
    await s.finalize("xy done");
    expect(firstCount).toBe(1);
  });
});

describe("createStreamer — finalize", () => {
  it("upgrades the streamed message to rich for part 1 and sends the rest as rich", async () => {
    const s = createStreamer(api, 42, { now: () => clock });
    s.onText("hi");
    await tick(); // message_id 100

    const long = "word ".repeat(7000); // > 32768 -> splits
    await s.finalize(long);

    const rich = api.calls.filter((c) => c.rich);
    expect(rich.some((c) => c.op === "edit" && c.messageId === 100)).toBe(true);
    expect(rich.some((c) => c.op === "send")).toBe(true);
  });

  it("retries with a plain edit when the rich edit fails", async () => {
    api.failRich = true;
    const s = createStreamer(api, 42, { now: () => clock });
    s.onText("hi");
    await tick(); // send -> message_id 100

    await s.finalize("hello world");

    const edits = api.calls.filter((c) => c.op === "edit");
    expect(edits.some((c) => c.rich)).toBe(true); // attempted rich, threw
    expect(edits.some((c) => !c.rich && c.messageId === 100)).toBe(true); // plain retry
  });

  it("waits for an in-flight stream send before finalizing (no duplicate, no stuck cursor)", async () => {
    // Gate the first sendMessage so it is still in flight when finalize runs.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gatedApi = {
      calls: [] as Call[],
      async sendMessage(_c: number, text: string) {
        gatedApi.calls.push({ op: "send", text, rich: false });
        await gate;
        return { message_id: 100 };
      },
      async editMessageText(_c: number, messageId: number, c: string | { markdown: string }) {
        const [text, rich] = content(c);
        gatedApi.calls.push({ op: "edit", text, rich, messageId });
        return true;
      },
      async sendRichMessage(_c: number, richMessage: { markdown: string }) {
        gatedApi.calls.push({ op: "send", text: richMessage.markdown, rich: true });
        return {};
      },
    };
    const s = createStreamer(gatedApi, 42, { now: () => clock });

    s.onText("hi"); // starts the (gated) first send
    const fin = s.finalize("final answer"); // must await the in-flight send
    release(); // let the stream send resolve -> messageId = 100
    await fin;

    // Exactly one send (the stream one); finalize edited that message, did not send a duplicate.
    expect(gatedApi.calls.filter((c) => c.op === "send")).toHaveLength(1);
    expect(gatedApi.calls.some((c) => c.op === "edit" && c.messageId === 100 && c.rich)).toBe(true);
  });

  it("sends a new rich message when nothing was streamed", async () => {
    let firstCount = 0;
    const s = createStreamer(api, 7, { now: () => clock, onFirstChunk: () => firstCount++ });
    await s.finalize("just a reply");

    expect(firstCount).toBe(1);
    const sends = api.calls.filter((c) => c.op === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0]!.rich).toBe(true);
  });
});
