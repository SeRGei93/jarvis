import { splitMessage, RICH_MAX_MESSAGE_LEN, type RichContent } from "./format.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "tg-messenger" });

/** Re-send the typing action this often (Telegram's indicator expires after ~5s). */
export const TYPING_INTERVAL_MS = 4000;

/**
 * Minimal grammY `Api` surface — `bot.api` satisfies it structurally. Outbound
 * replies are sent as Bot API 10.1 rich messages (markdown); a failed rich send
 * retries as plain text so a message always gets through.
 */
export interface MessengerApi {
  sendRichMessage(chatId: number, richMessage: RichContent): Promise<unknown>;
  sendMessage(chatId: number, text: string): Promise<unknown>;
  sendChatAction(chatId: number, action: "typing"): Promise<unknown>;
}

export interface MessengerOptions {
  /** Typing re-send interval (tests). */
  intervalMs?: number;
}

/**
 * Outbound message helper over `bot.api`: splits across the rich limit and sends
 * each part as a rich message, falling back to plain text on a send error. Used
 * for command replies and (M7) cron notifications — the streaming reply path
 * uses stream.ts.
 */
export class Messenger {
  private readonly intervalMs: number;

  constructor(
    private readonly api: MessengerApi,
    opts: MessengerOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? TYPING_INTERVAL_MS;
  }

  /** Split + send. Each part is a rich message; retries as plain text on error. */
  async sendMessage(chatId: number, text: string): Promise<void> {
    const parts = splitMessage(text, RICH_MAX_MESSAGE_LEN);
    if (parts.length === 0) return;
    log.debug({ chatId, parts: parts.length }, "send message");
    for (const part of parts) {
      try {
        await this.api.sendRichMessage(chatId, { markdown: part });
      } catch (err) {
        log.warn({ chatId, reason: err instanceof Error ? err.message : String(err) }, "rich send failed -> plain");
        await this.api.sendMessage(chatId, part).catch((e) =>
          log.warn({ chatId, reason: e instanceof Error ? e.message : String(e) }, "plain send failed"),
        );
      }
    }
  }

  /** Send a single typing action (best-effort). */
  async sendTyping(chatId: number): Promise<void> {
    await this.api.sendChatAction(chatId, "typing").catch(() => {});
  }

  /**
   * Start re-sending the typing indicator every {@link TYPING_INTERVAL_MS} until
   * the returned stop function is called. Fires once immediately.
   */
  startTypingLoop(chatId: number): () => void {
    void this.sendTyping(chatId);
    const timer = setInterval(() => void this.sendTyping(chatId), this.intervalMs);
    return () => clearInterval(timer);
  }
}
