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
  /**
   * Show a transient tool-activity status (e.g. "🔎 ищу…") as a draft. Ignored once
   * answer text has begun streaming or the reply is finalized, so it never clobbers
   * the real answer (B2). Used for the friendly (non-admin) status path.
   */
  status(label: string): void;
  /**
   * Admin-only debug: set the accumulated reasoning text. While streaming it is
   * shown in a native `<tg-thinking>` block (RichBlockThinking, draft-only); in the
   * finalized reply it persists inside a collapsed `<details>` block.
   */
  setReasoning(accumulated: string): void;
  /**
   * Admin-only debug: set the live tool/skill trace footer. Composed into the
   * streaming draft (below the answer) and kept in the finalized reply too, so the
   * record of which tools/skills ran persists after streaming.
   */
  setTrace(footer: string): void;
  /** Persist the finalized reply as rich message(s) (split if huge). */
  finalize(fullText: string): Promise<void>;
}

/** Cap reasoning shown in a draft/reply so it never blows the rich-message limit. */
const REASONING_MAX_CHARS = 3500;

/** Escape the chars that would break the rich-message HTML blocks we wrap reasoning in. */
function escapeRichHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Trim + tail-truncate reasoning to the display cap. */
function capReasoning(text: string): string {
  const t = text.trim();
  return [...t].length > REASONING_MAX_CHARS ? "…" + [...t].slice(-REASONING_MAX_CHARS).join("") : t;
}

/**
 * Native streaming "thinking" block (RichBlockThinking). Per the Telegram docs the
 * `<tg-thinking>` tag is valid only in `sendRichMessageDraft`, so this is used for
 * the live draft — the finalized reply uses reasoningDetails() instead.
 */
function thinkingBlock(text: string): string {
  const body = capReasoning(text);
  return body ? `<tg-thinking>${escapeRichHtml(body)}</tg-thinking>` : "";
}

/**
 * Collapsible `<details>` block that persists the reasoning in the finalized reply
 * (collapsed by default — tap to expand). Valid in `sendRichMessage`.
 */
function reasoningDetails(text: string): string {
  const body = capReasoning(text);
  return body ? `<details><summary>🧠 Рассуждения</summary>\n\n${escapeRichHtml(body)}\n\n</details>` : "";
}

/**
 * Strip media blocks from rich markdown. A single bad media URL (e.g. an
 * unreachable / fabricated image) makes Telegram reject the WHOLE rich message,
 * so on a failed send we retry without media to keep the rest formatted.
 */
export function stripMediaBlocks(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // ![alt](url)
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/<tg-(collage|slideshow)\b[\s\S]*?<\/tg-\1>/gi, "")
    .replace(/<figure\b[\s\S]*?<\/figure>/gi, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  let textStarted = false; // has answer text begun streaming?
  let firstChunkFired = false;
  let finalized = false;
  // Admin-only debug overlays composed into the draft (see composeDraft).
  let answerAcc = ""; // accumulated answer text (the `onText` value)
  let reasoningText = ""; // accumulated reasoning — persists into finalize
  let traceFooter = ""; // live tool/skill trace — dropped on finalize
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

  // Compose the draft: the reasoning "thinking" block (on top, like the bot is
  // thinking), then the answer, then the tool/skill trace footer (ephemeral). The
  // thinking block and trace are admin-only debug overlays.
  function composeDraft(): string {
    const parts: string[] = [];
    const thinking = reasoningText ? thinkingBlock(reasoningText) : "";
    if (thinking) parts.push(thinking);
    if (answerAcc) parts.push(answerAcc);
    if (traceFooter) parts.push(traceFooter);
    return parts.join("\n\n");
  }

  // Throttled draft tick — recompose and send unless unchanged / over the limit /
  // ending mid-link. Drives onText + the debug overlay setters through one throttle.
  const tick = (): void => {
    if (finalized || sending) return;
    const draft = composeDraft();
    if (draft === "" || draft === lastSentText) return;
    if ([...draft].length > STREAM_MAX_DRAFT_LEN) return; // near the limit: wait for finalize
    if (endsWithIncompleteLink(answerAcc)) return; // only the answer part must be link-complete
    // Throttle ticks after the first — the first draft is sent immediately.
    if (started && now() - lastSentAt < throttleMs) return;
    pending = flush(draft);
  };

  const onText: StreamCallback = (acc: string): void => {
    if (finalized || sending) return;
    if (acc === "" || acc === answerAcc) return;
    answerAcc = acc;
    textStarted = true; // answer text is now flowing — friendly status drafts stop here
    tick();
  };

  // Transient tool-activity status — shown only before answer text begins, so it
  // never overwrites the real answer. Sent immediately (status changes are rare).
  // Friendly (non-admin) path; the admin debug path uses setReasoning/setTrace.
  const status = (label: string): void => {
    if (finalized || textStarted || sending) return;
    if (label === "" || label === lastSentText) return;
    pending = flush(label);
  };

  const setReasoning = (acc: string): void => {
    if (acc === reasoningText) return;
    reasoningText = acc;
    tick();
  };

  const setTrace = (footer: string): void => {
    if (footer === traceFooter) return;
    traceFooter = footer;
    tick();
  };

  /**
   * Persist one finalize part as a rich message. On failure (often a bad media
   * URL rejecting the whole message) retry rich WITHOUT media blocks, then fall
   * back to plain text as a last resort.
   */
  async function sendWithFallback(text: string): Promise<void> {
    const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));
    try {
      await api.sendRichMessage(chatId, { markdown: text });
      return;
    } catch (err) {
      log.warn({ reason: reason(err) }, "finalize rich send failed");
    }
    const noMedia = stripMediaBlocks(text);
    if (noMedia !== text && noMedia !== "") {
      try {
        await api.sendRichMessage(chatId, { markdown: noMedia });
        return;
      } catch (err) {
        log.warn({ reason: reason(err) }, "finalize rich send (no media) failed -> plain");
      }
    }
    await api.sendMessage(chatId, noMedia || text).catch(() => {});
  }

  async function finalize(fullText: string): Promise<void> {
    finalized = true;
    await pending.catch(() => {}); // let the last in-flight draft settle first
    fireFirstChunk(); // ensure typing stops even when nothing streamed
    // Keep both debug overlays in the persisted reply: the tool/skill trace
    // footer AND the reasoning, the latter in a collapsed <details> block (the
    // draft-only <tg-thinking> can't be used here).
    const details = reasoningText ? reasoningDetails(reasoningText) : "";
    const extras = [traceFooter, details].filter(Boolean).join("\n\n");
    const finalText = extras ? `${fullText}\n\n${extras}` : fullText;
    const parts = splitMessage(finalText, RICH_MAX_MESSAGE_LEN);
    if (parts.length === 0) parts.push(""); // always send something to replace the draft
    log.debug({ chatId, parts: parts.length, streamed: started, reasoning: details !== "", trace: traceFooter !== "" }, "finalize");
    for (const part of parts) {
      await sendWithFallback(part);
    }
  }

  return { onText, status, setReasoning, setTrace, finalize };
}
