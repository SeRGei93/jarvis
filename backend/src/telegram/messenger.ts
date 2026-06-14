import { toTelegramMarkdown, splitMessage, TELEGRAM_MAX_MESSAGE_LEN } from "./format.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "tg-messenger" });

/** Re-send the typing action this often (Telegram's indicator expires after ~5s). */
export const TYPING_INTERVAL_MS = 4000;

/** Minimal grammY `Api` surface — `bot.api` satisfies it structurally. */
export interface MessengerApi {
  sendMessage(chatId: number, text: string, other?: { parse_mode?: "MarkdownV2" }): Promise<unknown>;
  sendChatAction(chatId: number, action: "typing"): Promise<unknown>;
}

export interface MessengerOptions {
  /** Typing re-send interval (tests). */
  intervalMs?: number;
}

/**
 * Outbound message helper over `bot.api`: formats to MarkdownV2, splits across
 * the 4096 limit, and falls back to plain text on a parse error. Used for command
 * replies and (M7) cron notifications — the streaming reply path uses stream.ts.
 */
export class Messenger {
  private readonly intervalMs: number;

  constructor(
    private readonly api: MessengerApi,
    opts: MessengerOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? TYPING_INTERVAL_MS;
  }

  /** Format + split + send. Each part retries as plain text if MarkdownV2 fails. */
  async sendMessage(chatId: number, text: string): Promise<void> {
    const parts = splitMessage(toTelegramMarkdown(text), TELEGRAM_MAX_MESSAGE_LEN);
    if (parts.length === 0) return;
    log.debug({ chatId, parts: parts.length }, "send message");
    for (const part of parts) {
      try {
        await this.api.sendMessage(chatId, part, { parse_mode: "MarkdownV2" });
      } catch (err) {
        log.warn({ chatId, reason: err instanceof Error ? err.message : String(err) }, "send failed -> plain");
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
