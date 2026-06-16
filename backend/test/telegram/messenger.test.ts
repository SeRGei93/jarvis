import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Messenger, type MessengerApi } from "../../src/telegram/messenger.js";
import { RICH_MAX_MESSAGE_LEN } from "../../src/telegram/format.js";

interface Call {
  op: "rich" | "send" | "action";
  text?: string;
  action?: string;
}

class FakeApi implements MessengerApi {
  calls: Call[] = [];
  failRich = false;
  async sendRichMessage(_chatId: number, richMessage: { markdown: string }) {
    this.calls.push({ op: "rich", text: richMessage.markdown });
    if (this.failRich) throw new Error("can't parse rich");
    return {};
  }
  async sendMessage(_chatId: number, text: string) {
    this.calls.push({ op: "send", text });
    return {};
  }
  async sendChatAction(_chatId: number, action: "typing") {
    this.calls.push({ op: "action", action });
    return {};
  }
}

let api: FakeApi;
beforeEach(() => {
  api = new FakeApi();
});

describe("Messenger.sendMessage", () => {
  it("sends a rich message (markdown passed through verbatim)", async () => {
    await new Messenger(api).sendMessage(42, "**hi**");
    expect(api.calls).toEqual([{ op: "rich", text: "**hi**" }]);
  });

  it("splits a long message into multiple rich parts", async () => {
    const long = "word ".repeat(7000); // > 32768 -> splits
    await new Messenger(api).sendMessage(42, long);
    const sends = api.calls.filter((c) => c.op === "rich");
    expect(sends.length).toBeGreaterThan(1);
    for (const c of sends) expect([...(c.text ?? "")].length).toBeLessThanOrEqual(RICH_MAX_MESSAGE_LEN);
  });

  it("retries as plain text when the rich send fails", async () => {
    api.failRich = true;
    await new Messenger(api).sendMessage(42, "**hi**");
    expect(api.calls[0]).toMatchObject({ op: "rich", text: "**hi**" });
    expect(api.calls[1]).toMatchObject({ op: "send", text: "**hi**" });
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
