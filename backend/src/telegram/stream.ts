import type { StreamCallback } from "../mastra/llm.js";
import { toTelegramMarkdown, splitMessage, TELEGRAM_MAX_MESSAGE_LEN } from "./format.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "tg-stream" });

/** Throttle between edit ticks. editMessageText is rate-limited harder than Go's drafts (200ms). */
export const STREAM_THROTTLE_MS = 1000;
/** Stop streaming edits before the 4096 limit so finalize formatting/splitting has room. */
export const STREAM_MAX_PLAIN_LEN = 3800;
/** Trailing cursor shown while streaming (dropped on finalize). */
export const STREAM_CURSOR = " ▌";

/**
 * Minimal grammY `Api` surface the streamer needs — `bot.api` satisfies it
 * structurally, and tests pass a fake. Streaming ticks send PLAIN text (no
 * parse_mode); MarkdownV2 is applied only in `finalize`.
 */
export interface TelegramSender {
  sendMessage(
    chatId: number,
    text: string,
    other?: { parse_mode?: "MarkdownV2" },
  ): Promise<{ message_id: number }>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    other?: { parse_mode?: "MarkdownV2" },
  ): Promise<unknown>;
}

export interface StreamerOptions {
  /** Called once, when the first chunk is sent — used to stop the typing indicator. */
  onFirstChunk?: () => void;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Override throttle (tests). */
  throttleMs?: number;
}

export interface Streamer {
  /** Wire as the chat workflow `onText` callback (receives accumulated text). */
  onText: StreamCallback;
  /** Send the finalized reply as formatted MarkdownV2 (split across messages). */
  finalize(fullText: string): Promise<void>;
}

/** True if the accumulated text ends inside an unterminated markdown link. */
function endsWithIncompleteLink(s: string): boolean {
  const open = s.lastIndexOf("[");
  if (open === -1) return false;
  const close = s.indexOf("]", open);
  if (close === -1) return true; // "[text..." not closed
  const after = s.slice(close + 1);
  if (after.startsWith("(")) return !after.includes(")"); // "](url..." not closed
  return false;
}

/**
 * Builds a throttled streamer over Telegram `editMessageText`. The first chunk
 * sends a new message; subsequent chunks edit it (plain text + cursor) no more
 * than once per `throttleMs`. `finalize` converts the full reply to MarkdownV2,
 * splits it across messages, edits the streamed message for the first part and
 * sends the rest, with a plain-text retry when MarkdownV2 fails to parse.
 */
export function createStreamer(
  api: TelegramSender,
  chatId: number,
  opts: StreamerOptions = {},
): Streamer {
  const now = opts.now ?? Date.now;
  const throttleMs = opts.throttleMs ?? STREAM_THROTTLE_MS;

  let messageId: number | undefined;
  let lastSentText = "";
  let lastSentAt = 0;
  let sending = false;
  let firstChunkFired = false;
  let finalized = false;

  const fireFirstChunk = (): void => {
    if (firstChunkFired) return;
    firstChunkFired = true;
    try {
      opts.onFirstChunk?.();
    } catch {
      /* stopping the typing indicator must never break streaming */
    }
  };

  async function flush(acc: string): Promise<void> {
    sending = true;
    try {
      const text = acc + STREAM_CURSOR;
      if (messageId === undefined) {
        const m = await api.sendMessage(chatId, text);
        messageId = m.message_id;
        fireFirstChunk();
      } else {
        await api.editMessageText(chatId, messageId, text);
      }
      lastSentText = acc;
      lastSentAt = now();
    } catch (err) {
      // A failed tick is non-fatal: skip it, the next tick (or finalize) recovers.
      log.warn({ reason: err instanceof Error ? err.message : String(err) }, "stream tick failed");
    } finally {
      sending = false;
    }
  }

  const onText: StreamCallback = (acc: string): void => {
    if (finalized || sending) return;
    if (acc === "" || acc === lastSentText) return;
    if ([...acc].length > STREAM_MAX_PLAIN_LEN) return; // near the limit: wait for finalize
    if (endsWithIncompleteLink(acc)) return;
    // Throttle edits only — the first chunk is sent immediately.
    if (messageId !== undefined && now() - lastSentAt < throttleMs) return;
    void flush(acc);
  };

  async function editWithFallback(id: number, text: string): Promise<void> {
    try {
      await api.editMessageText(chatId, id, text, { parse_mode: "MarkdownV2" });
    } catch (err) {
      log.warn({ reason: err instanceof Error ? err.message : String(err) }, "finalize edit failed -> plain");
      await api.editMessageText(chatId, id, text).catch(() => {});
    }
  }

  async function sendWithFallback(text: string): Promise<void> {
    try {
      await api.sendMessage(chatId, text, { parse_mode: "MarkdownV2" });
    } catch (err) {
      log.warn({ reason: err instanceof Error ? err.message : String(err) }, "finalize send failed -> plain");
      await api.sendMessage(chatId, text).catch(() => {});
    }
  }

  async function finalize(fullText: string): Promise<void> {
    finalized = true;
    fireFirstChunk(); // ensure typing stops even when nothing streamed
    const parts = splitMessage(toTelegramMarkdown(fullText), TELEGRAM_MAX_MESSAGE_LEN);
    if (parts.length === 0) parts.push(""); // always replace the cursor with something
    log.debug({ chatId, parts: parts.length, streamed: messageId !== undefined }, "finalize");

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      if (i === 0 && messageId !== undefined) {
        await editWithFallback(messageId, part);
      } else {
        await sendWithFallback(part);
      }
    }
  }

  return { onText, finalize };
}
