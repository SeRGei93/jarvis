import type { StreamCallback } from "../mastra/llm.js";
import { splitMessage, RICH_MAX_MESSAGE_LEN, type RichContent } from "./format.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "tg-stream" });

/**
 * Throttle between draft ticks. `sendRichMessageDraft` is the Bot API 10.1
 * streaming primitive — ephemeral previews that are NOT edit-flood-limited like
 * `editMessageText`, so we can refresh fast (parity-ish with the Go 200ms draft
 * path) for a smooth typing effect.
 */
export const STREAM_THROTTLE_MS = 250;
/** Stop streaming near the rich-message limit; finalize then splits the full reply. */
export const STREAM_MAX_DRAFT_LEN = 32000;

/**
 * Minimal grammY `Api` surface the streamer needs — `bot.api` satisfies it
 * structurally, and tests pass a fake. The live preview streams ephemeral rich
 * drafts; finalize persists the reply with `sendRichMessage` (plain fallback).
 */
export interface TelegramSender {
  /** Bot API 10.1 streaming draft — an ephemeral ~30s preview keyed by `draftId`. */
  sendRichMessageDraft(chatId: number, draftId: number, richMessage: RichContent): Promise<unknown>;
  /** Persist the finalized reply as a rich message. */
  sendRichMessage(chatId: number, richMessage: RichContent): Promise<unknown>;
  /** Plain-text fallback when a rich send fails to parse. */
  sendMessage(chatId: number, text: string): Promise<unknown>;
}

export interface StreamerOptions {
  /** Called once, when the first draft is sent — used to stop the typing indicator. */
  onFirstChunk?: () => void;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Override throttle (tests). */
  throttleMs?: number;
}

export interface Streamer {
  /** Wire as the chat workflow `onText` callback (receives accumulated text). */
  onText: StreamCallback;
  /** Persist the finalized reply as rich message(s) (split if huge). */
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
 * Builds a throttled streamer over Telegram's rich-message drafts. Each tick
 * sends the accumulated text as a `sendRichMessageDraft` (an ephemeral preview
 * Telegram renders while the bot "types"), no more than once per `throttleMs`.
 * `finalize` persists the full reply via `sendRichMessage` (split across messages
 * if it exceeds the rich limit), with a plain-text retry when the rich send fails.
 *
 * `draftId` correlates the streaming session to the user's message (the inbound
 * `update_id`); the draft expires on its own once the real message is sent.
 */
export function createStreamer(
  api: TelegramSender,
  chatId: number,
  draftId: number,
  opts: StreamerOptions = {},
): Streamer {
  const now = opts.now ?? Date.now;
  const throttleMs = opts.throttleMs ?? STREAM_THROTTLE_MS;

  let lastSentText = "";
  let lastSentAt = 0;
  let sending = false;
  let started = false; // have we sent at least one draft?
  let firstChunkFired = false;
  let finalized = false;
  // Tracks the in-flight draft so finalize can wait for it — a late draft must
  // not land after the persisted message and briefly re-show a stale preview.
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
      await api.sendRichMessageDraft(chatId, draftId, { markdown: acc });
      if (!started) {
        started = true;
        fireFirstChunk();
      }
      lastSentText = acc;
      lastSentAt = now();
    } catch (err) {
      // A failed tick is non-fatal: skip it, the next tick (or finalize) recovers.
      log.warn({ reason: err instanceof Error ? err.message : String(err) }, "stream draft tick failed");
    } finally {
      sending = false;
    }
  }

  const onText: StreamCallback = (acc: string): void => {
    if (finalized || sending) return;
    if (acc === "" || acc === lastSentText) return;
    if ([...acc].length > STREAM_MAX_DRAFT_LEN) return; // near the limit: wait for finalize
    if (endsWithIncompleteLink(acc)) return;
    // Throttle ticks after the first — the first draft is sent immediately.
    if (started && now() - lastSentAt < throttleMs) return;
    pending = flush(acc);
  };

  /** Persist one finalize part as a rich message; fall back to plain text. */
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
    await pending.catch(() => {}); // let the last in-flight draft settle first
    fireFirstChunk(); // ensure typing stops even when nothing streamed
    const parts = splitMessage(fullText, RICH_MAX_MESSAGE_LEN);
    if (parts.length === 0) parts.push(""); // always send something to replace the draft
    log.debug({ chatId, parts: parts.length, streamed: started }, "finalize");
    for (const part of parts) {
      await sendWithFallback(part);
    }
  }

  return { onText, finalize };
}
