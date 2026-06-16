import type { StreamCallback } from "../mastra/llm.js";
import { splitMessage, RICH_MAX_MESSAGE_LEN, type RichContent } from "./format.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "tg-stream" });

/**
 * Throttle between edit ticks. editMessageText is flood-limited per message, so
 * this is the safe floor for the live preview (~2 edits/sec in a private chat);
 * going much lower risks 429s. For genuinely smooth streaming switch the preview
 * to sendRichMessageDraft (Bot API 10.1 drafts are cheap, like Go's 200ms path).
 */
export const STREAM_THROTTLE_MS = 500;
/** Stop streaming edits before the 4096 plain limit so finalize has room to upgrade to rich. */
export const STREAM_MAX_PLAIN_LEN = 3800;
/** Trailing cursor shown while streaming (dropped on finalize). */
export const STREAM_CURSOR = " ▌";

/**
 * Minimal grammY `Api` surface the streamer needs — `bot.api` satisfies it
 * structurally, and tests pass a fake. Streaming ticks send PLAIN text (no
 * formatting); the finalized reply is sent as a Bot API 10.1 rich message
 * (markdown) — the streamed preview is upgraded in place via `editMessageText`.
 */
export interface TelegramSender {
  sendMessage(chatId: number, text: string): Promise<{ message_id: number }>;
  editMessageText(
    chatId: number,
    messageId: number,
    content: string | RichContent,
  ): Promise<unknown>;
  sendRichMessage(chatId: number, richMessage: RichContent): Promise<unknown>;
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
  /** Send the finalized reply as a rich message (split across messages if huge). */
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
 * sends a new (plain) message; subsequent chunks edit it (plain text + cursor)
 * no more than once per `throttleMs`. `finalize` splits the full reply, upgrades
 * the streamed message to a rich message (markdown) and sends any extra parts as
 * rich messages, with a plain-text retry when the rich send fails.
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
  // Tracks the in-flight stream edit so finalize can wait for it (a late edit must
  // not land after the final message and leave it stuck on a partial chunk + cursor).
  let pending: Promise<void> = Promise.resolve();

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
    pending = flush(acc);
  };

  /** Upgrade the streamed message to a rich message; fall back to a plain edit. */
  async function editWithFallback(id: number, text: string): Promise<void> {
    try {
      await api.editMessageText(chatId, id, { markdown: text });
    } catch (err) {
      log.warn({ reason: err instanceof Error ? err.message : String(err) }, "finalize rich edit failed -> plain");
      await api.editMessageText(chatId, id, text).catch(() => {});
    }
  }

  /** Send an extra finalize part as a rich message; fall back to plain text. */
  async function sendWithFallback(text: string): Promise<void> {
    try {
      await api.sendRichMessage(chatId, { markdown: text });
    } catch (err) {
      log.warn({ reason: err instanceof Error ? err.message : String(err) }, "finalize rich send failed -> plain");
      await api.sendMessage(chatId, text).catch(() => {});
    }
  }

  async function finalize(fullText: string): Promise<void> {
    finalized = true;
    await pending.catch(() => {}); // let the last in-flight stream edit settle (sets messageId)
    fireFirstChunk(); // ensure typing stops even when nothing streamed
    const parts = splitMessage(fullText, RICH_MAX_MESSAGE_LEN);
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
