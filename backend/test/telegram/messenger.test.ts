import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Messenger, type MessengerApi } from "../../src/telegram/messenger.js";

interface Call {
  op: "send" | "action";
  text?: string;
  parse?: string;
  action?: string;
}

class FakeApi implements MessengerApi {
  calls: Call[] = [];
  failParse = false;
  async sendMessage(_chatId: number, text: string, other?: { parse_mode?: "MarkdownV2" }) {
    this.calls.push({ op: "send", text, parse: other?.parse_mode });
    if (other?.parse_mode && this.failParse) throw new Error("can't parse entities");
    return {};
  }
  async sendChatAction(_chatId: number, action: "typing") {
    this.calls.push({ op: "action", action });
    return {};
  }
}

const tick = () => new Promise((r) => setImmediate(r));

let api: FakeApi;
beforeEach(() => {
  api = new FakeApi();
});

describe("Messenger.sendMessage", () => {
  it("sends a formatted MarkdownV2 message", async () => {
    await new Messenger(api).sendMessage(42, "**hi**");
    expect(api.calls).toEqual([{ op: "send", text: "*hi*", parse: "MarkdownV2" }]);
  });

  it("splits a long message into multiple parts", async () => {
    const long = "word ".repeat(1200); // > 4096
    await new Messenger(api).sendMessage(42, long);
    const sends = api.calls.filter((c) => c.op === "send");
    expect(sends.length).toBeGreaterThan(1);
    for (const c of sends) expect([...(c.text ?? "")].length).toBeLessThanOrEqual(4096);
  });

  it("retries as plain text when MarkdownV2 fails", async () => {
    api.failParse = true;
    await new Messenger(api).sendMessage(42, "**hi**");
    expect(api.calls[0]).toMatchObject({ op: "send", parse: "MarkdownV2" });
    expect(api.calls[1]).toMatchObject({ op: "send", parse: undefined });
  });

  it("sends nothing for empty text", async () => {
    await new Messenger(api).sendMessage(42, "");
    expect(api.calls).toHaveLength(0);
  });
});

describe("Messenger typing loop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires immediately and re-fires on the interval until stopped", async () => {
    const m = new Messenger(api, { intervalMs: 4000 });
    const stop = m.startTypingLoop(42);
    expect(api.calls.filter((c) => c.op === "action")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(4000);
    expect(api.calls.filter((c) => c.op === "action")).toHaveLength(2);

    stop();
    await vi.advanceTimersByTimeAsync(8000);
    expect(api.calls.filter((c) => c.op === "action")).toHaveLength(2);
  });
});
