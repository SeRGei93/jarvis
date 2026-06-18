import { describe, it, expect, beforeEach } from "vitest";
import { createStreamer, type TelegramSender } from "../../src/telegram/stream.js";

interface Call {
  op: "draft" | "send";
  text: string;
  rich: boolean; // for "send": rich vs plain fallback
  draftId?: number;
}

const DRAFT_ID = 7;

class FakeApi implements TelegramSender {
  calls: Call[] = [];
  failRich = false;

  async sendRichMessageDraft(_chatId: number, draftId: number, richMessage: { markdown: string }) {
    this.calls.push({ op: "draft", text: richMessage.markdown, rich: true, draftId });
    return {};
  }
  async sendRichMessage(_chatId: number, richMessage: { markdown: string }) {
    this.calls.push({ op: "send", text: richMessage.markdown, rich: true });
    if (this.failRich) throw new Error("can't parse rich");
    return {};
  }
  async sendMessage(_chatId: number, text: string) {
    this.calls.push({ op: "send", text, rich: false });
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

describe("createStreamer — streaming (rich drafts)", () => {
  it("sends the first draft immediately, then throttled accumulated drafts", async () => {
    const s = createStreamer(api, 42, DRAFT_ID, { now: () => clock, throttleMs: 1000 });

    s.onText("hello");
    await tick();
    expect(api.calls[0]).toMatchObject({ op: "draft", text: "hello", draftId: DRAFT_ID });

    clock = 1000;
    s.onText("hello world");
    await tick();
    expect(api.calls[1]).toMatchObject({ op: "draft", text: "hello world", draftId: DRAFT_ID });
  });

  it("shows a tool status draft before text, then text takes over (B2)", async () => {
    const s = createStreamer(api, 42, DRAFT_ID, { now: () => clock, throttleMs: 1000 });

    s.status("🔎 ищу…");
    await tick();
    expect(api.calls[0]).toMatchObject({ op: "draft", text: "🔎 ищу…" });

    clock = 1000;
    s.onText("the answer");
    await tick();
    expect(api.calls[1]).toMatchObject({ op: "draft", text: "the answer" });
  });

  it("ignores tool status once answer text has begun (never clobbers the answer)", async () => {
    const s = createStreamer(api, 42, DRAFT_ID, { now: () => clock, throttleMs: 1000 });

    s.onText("partial answer");
    await tick();
    expect(api.calls).toHaveLength(1);

    s.status("🔎 ищу…"); // text already started -> ignored
    await tick();
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatchObject({ text: "partial answer" });
  });

  it("throttles ticks within the window", async () => {
    const s = createStreamer(api, 42, DRAFT_ID, { now: () => clock, throttleMs: 1000 });

    s.onText("a");
    await tick(); // first draft (no throttle)
    clock = 500;
    s.onText("ab");
    await tick(); // 500 < 1000 -> skipped
    expect(api.calls).toHaveLength(1);

    clock = 1000;
    s.onText("abc");
    await tick();
    expect(api.calls).toHaveLength(2);
  });

  it("skips a chunk that exceeds the draft guard", async () => {
    const s = createStreamer(api, 42, DRAFT_ID, { now: () => clock });
    s.onText("x".repeat(33000));
    await tick();
    expect(api.calls).toHaveLength(0);
  });

  it("skips a chunk ending in an incomplete link", async () => {
    const s = createStreamer(api, 42, DRAFT_ID, { now: () => clock });
    s.onText("see [docs");
    await tick();
    expect(api.calls).toHaveLength(0);

    s.onText("see [docs](http://e.com)");
    await tick();
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.op).toBe("draft");
  });

  it("stops the typing indicator once, on the first draft", async () => {
    let firstCount = 0;
    const s = createStreamer(api, 42, DRAFT_ID, { now: () => clock, onFirstChunk: () => firstCount++ });
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
  it("persists the reply via sendRichMessage, splitting a huge reply", async () => {
    const s = createStreamer(api, 42, DRAFT_ID, { now: () => clock });
    s.onText("hi");
    await tick(); // one draft

    const long = "word ".repeat(7000); // > 32768 -> splits
    await s.finalize(long);

    const sends = api.calls.filter((c) => c.op === "send" && c.rich);
    expect(sends.length).toBeGreaterThan(1);
    // finalize persists; it does not emit more drafts.
    expect(api.calls.filter((c) => c.op === "draft")).toHaveLength(1);
  });

  it("retries as plain text when the rich send fails", async () => {
    api.failRich = true;
    const s = createStreamer(api, 42, DRAFT_ID, { now: () => clock });

    await s.finalize("hello world");

    const sends = api.calls.filter((c) => c.op === "send");
    expect(sends.some((c) => c.rich)).toBe(true); // attempted rich, threw
    expect(sends.some((c) => !c.rich && c.text === "hello world")).toBe(true); // plain retry
  });

  it("waits for an in-flight draft before persisting the reply", async () => {
    // Gate the first draft so it is still in flight when finalize runs.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const gatedApi = {
      async sendRichMessageDraft(_c: number, _d: number, _r: { markdown: string }) {
        order.push("draft-start");
        await gate;
        order.push("draft-done");
        return {};
      },
      async sendRichMessage(_c: number, _r: { markdown: string }) {
        order.push("send");
        return {};
      },
      async sendMessage(_c: number, _t: string) {
        return {};
      },
    };
    const s = createStreamer(gatedApi, 42, DRAFT_ID, { now: () => clock });

    s.onText("hi"); // starts the (gated) draft
    const fin = s.finalize("final answer"); // must await the in-flight draft first
    release();
    await fin;

    // The persisted send happens only after the in-flight draft settled.
    expect(order).toEqual(["draft-start", "draft-done", "send"]);
  });

  it("sends a rich message when nothing was streamed", async () => {
    let firstCount = 0;
    const s = createStreamer(api, 7, DRAFT_ID, { now: () => clock, onFirstChunk: () => firstCount++ });
    await s.finalize("just a reply");

    expect(firstCount).toBe(1);
    expect(api.calls.filter((c) => c.op === "draft")).toHaveLength(0);
    const sends = api.calls.filter((c) => c.op === "send");
    expect(sends).toHaveLength(1);
    expect(sends[0]!).toMatchObject({ rich: true, text: "just a reply" });
  });
});

describe("createStreamer — admin debug overlays (thinking block + trace)", () => {
  it("composes a <tg-thinking> block and the trace footer into the streaming draft", async () => {
    const s = createStreamer(api, 42, DRAFT_ID, { now: () => clock, throttleMs: 1000 });

    s.setReasoning("thinking hard");
    await tick();
    expect(api.calls[0]!.text).toBe("<tg-thinking>thinking hard</tg-thinking>");

    clock = 1000;
    s.setTrace("🔧 load_skill(currency) …");
    await tick();
    // Thinking block + trace; no answer text yet.
    expect(api.calls.at(-1)!.text).toBe("<tg-thinking>thinking hard</tg-thinking>\n\n🔧 load_skill(currency) …");

    clock = 2000;
    s.onText("here is the answer");
    await tick();
    // Thinking on top, then the answer, then the trace footer.
    expect(api.calls.at(-1)!.text).toBe(
      "<tg-thinking>thinking hard</tg-thinking>\n\nhere is the answer\n\n🔧 load_skill(currency) …",
    );
  });

  it("persists reasoning in a <details> block on finalize but drops the trace footer", async () => {
    const s = createStreamer(api, 42, DRAFT_ID, { now: () => clock, throttleMs: 1000 });
    s.setReasoning("my reasoning");
    s.setTrace("🔧 web_search(q=курс) ✓");
    await tick();

    await s.finalize("the answer");
    const sends = api.calls.filter((c) => c.op === "send");
    expect(sends).toHaveLength(1);
    // Reasoning persists in a collapsed details block; trace footer is gone.
    expect(sends[0]!.text).toBe(
      "the answer\n\n<details><summary>🧠 Рассуждения</summary>\n\nmy reasoning\n\n</details>",
    );
    expect(sends[0]!.text).not.toContain("🔧");
    expect(sends[0]!.text).not.toContain("<tg-thinking>"); // draft-only tag never in the final
  });

  it("escapes HTML-special chars in reasoning so the blocks don't break", async () => {
    const s = createStreamer(api, 42, DRAFT_ID, { now: () => clock });
    s.setReasoning("compare a<b && c>d");
    await tick();
    expect(api.calls[0]!.text).toBe("<tg-thinking>compare a&lt;b &amp;&amp; c&gt;d</tg-thinking>");
  });

  it("finalizes a plain reply unchanged when there was no reasoning", async () => {
    const s = createStreamer(api, 42, DRAFT_ID, { now: () => clock });
    s.setTrace("🔧 weather() …"); // trace only — must not leak into the reply
    await tick();

    await s.finalize("just the answer");
    const sends = api.calls.filter((c) => c.op === "send");
    expect(sends[0]!.text).toBe("just the answer");
  });
});
