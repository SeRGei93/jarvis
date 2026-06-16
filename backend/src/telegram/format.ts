import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "tg-format" });

/**
 * Rich-message content sent to Telegram (Bot API 10.1 `InputRichMessage`,
 * markdown variant). The source is the LLM's GFM-style markdown — Telegram's
 * rich markdown is a GFM superset (tables, headings, lists, blockquotes, …), so
 * it is passed through almost verbatim, no MarkdownV2 escaping needed.
 */
export interface RichContent {
  markdown: string;
}

/**
 * Telegram limit for a plain text message (code points). Used for the live
 * streaming preview, which is sent as a normal `sendMessage` before finalize
 * upgrades it to a rich message.
 */
export const TELEGRAM_MAX_MESSAGE_LEN = 4096;

/**
 * Telegram limit for a *rich* message text (Bot API 10.1 `sendRichMessage` —
 * "up to 32768 UTF-8 characters"). Finalized replies are sent as rich markdown,
 * so they split at this larger bound, not the 4096 plain limit.
 */
export const RICH_MAX_MESSAGE_LEN = 32768;

/** How far back from the limit we search for a clean split point. */
const SPLIT_SEARCH_WINDOW = 500;

/** Find the code-point index to cut at, searching back from `limit` for a clean break. */
function findCut(arr: string[], limit: number): number {
  const lo = Math.max(1, limit - SPLIT_SEARCH_WINDOW);
  for (let i = limit - 1; i >= lo; i--) {
    if (arr[i] === "\n" && arr[i - 1] === "\n") return i + 1; // paragraph break
  }
  for (let i = limit - 1; i >= lo; i--) {
    if (arr[i] === "\n") return i + 1; // line break
  }
  for (let i = limit - 1; i >= lo; i--) {
    if (arr[i] === " ") return i + 1; // word break
  }
  return limit; // hard cut
}

/**
 * Split a message into chunks no longer than `limit` code points, preferring
 * paragraph/line/word boundaries (search window 500). Returns [] for empty input.
 *
 * With rich messages the limit is 32768, so the vast majority of replies are a
 * single chunk; splitting is the rare long-reply fallback.
 */
export function splitMessage(text: string, limit = RICH_MAX_MESSAGE_LEN): string[] {
  if (text === "") return [];
  let arr = [...text];
  if (arr.length <= limit) return [text];

  const chunks: string[] = [];
  while (arr.length > limit) {
    const cut = findCut(arr, limit);
    const chunk = arr.slice(0, cut).join("").replace(/\s+$/, "");
    if (chunk !== "") chunks.push(chunk);
    arr = [...arr.slice(cut).join("").replace(/^\s+/, "")];
  }
  const tail = arr.join("");
  if (tail !== "") chunks.push(tail);
  log.debug({ total: text.length, parts: chunks.length, limit }, "split message");
  return chunks;
}
