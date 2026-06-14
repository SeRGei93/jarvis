import { marked } from "marked";
import type { Token, Tokens } from "marked";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "tg-format" });

/** Telegram hard limit per message (code points, parity with Go utf8.RuneCountInString). */
export const TELEGRAM_MAX_MESSAGE_LEN = 4096;
/** How far back from the limit we search for a clean split point (parity with Go split.go). */
const SPLIT_SEARCH_WINDOW = 500;

// MarkdownV2 reserved characters that must be backslash-escaped in normal text.
// https://core.telegram.org/bots/api#markdownv2-style
const SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/** Escape MarkdownV2 special characters in plain text segments. */
function esc(s: string): string {
  return s.replace(SPECIAL, (m) => "\\" + m);
}
/** Inside `code`/```pre``` only the backtick and backslash are special. */
function escCode(s: string): string {
  return s.replace(/[`\\]/g, (m) => "\\" + m);
}
/** Inside the (url) part of a link only ')' and '\' must be escaped. */
function escUrl(s: string): string {
  return s.replace(/[)\\]/g, (m) => "\\" + m);
}

/** marked leaves a few HTML entities in token text; decode the common ones. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#3?9;|&#x27;/g, "'");
}

/**
 * Render inline tokens to MarkdownV2.
 * `plain` strips all formatting markers (used where Telegram forbids nested
 * entities, e.g. inside a bold heading is fine but we keep the option).
 * Parity with Go format.go: **bold**→*bold*, *italic*→plain, ~~s~~→~s~,
 * `code` kept, links kept with escaped url, images→alt text, bare autolinks→clickable.
 */
function renderInline(tokens: Token[] | undefined, plain = false): string {
  if (!tokens) return "";
  let out = "";
  for (const t of tokens) {
    switch (t.type) {
      case "text": {
        const tt = t as Tokens.Text;
        if (tt.tokens && tt.tokens.length) out += renderInline(tt.tokens, plain);
        else out += esc(decodeEntities(tt.text));
        break;
      }
      case "escape":
        out += esc((t as Tokens.Escape).text);
        break;
      case "strong": {
        const inner = renderInline((t as Tokens.Strong).tokens, plain);
        out += plain ? inner : `*${inner}*`;
        break;
      }
      case "em":
        // Go parity: italics are rendered as plain text (no markers).
        out += renderInline((t as Tokens.Em).tokens, plain);
        break;
      case "del": {
        const inner = renderInline((t as Tokens.Del).tokens, plain);
        out += plain ? inner : `~${inner}~`;
        break;
      }
      case "codespan": {
        const raw = decodeEntities((t as Tokens.Codespan).text);
        out += plain ? raw : `\`${escCode(raw)}\``;
        break;
      }
      case "link": {
        const lk = t as Tokens.Link;
        const text = renderInline(lk.tokens, plain) || esc(decodeEntities(lk.text));
        out += plain ? text : `[${text}](${escUrl(lk.href)})`;
        break;
      }
      case "image": {
        const im = t as Tokens.Image;
        out += esc(decodeEntities(im.text || im.title || ""));
        break;
      }
      case "br":
        out += "\n";
        break;
      case "html":
        // Raw HTML is skipped entirely (parity with Go).
        break;
      default: {
        const anyTok = t as { text?: string; tokens?: Token[] };
        if (anyTok.tokens) out += renderInline(anyTok.tokens, plain);
        else if (typeof anyTok.text === "string") out += esc(decodeEntities(anyTok.text));
        break;
      }
    }
  }
  return out;
}

/** Render the blocks of a single list item; nested lists recurse at depth+1. */
function renderListItem(item: Tokens.ListItem, depth: number): string {
  const parts: string[] = [];
  for (const tok of item.tokens) {
    if (tok.type === "list") {
      parts.push(renderList(tok as Tokens.List, depth + 1));
    } else if (tok.type === "text") {
      const tt = tok as Tokens.Text;
      parts.push(renderInline(tt.tokens ?? [{ type: "text", raw: tt.text, text: tt.text } as Token]));
    } else if (tok.type === "paragraph") {
      parts.push(renderInline((tok as Tokens.Paragraph).tokens));
    } else {
      parts.push(renderBlock(tok, depth + 1) ?? "");
    }
  }
  return parts.filter((p) => p !== "").join("\n");
}

function renderList(list: Tokens.List, depth: number): string {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  let n = typeof list.start === "number" && list.start > 0 ? list.start : 1;
  for (const item of list.items) {
    const marker = list.ordered ? `${n}\\. ` : "• ";
    const body = renderListItem(item, depth).split("\n");
    lines.push(indent + marker + (body[0] ?? ""));
    for (let i = 1; i < body.length; i++) lines.push(indent + "  " + body[i]);
    n++;
  }
  return lines.join("\n");
}

/** Render one block-level token to MarkdownV2, or null to drop it. */
function renderBlock(token: Token, depth: number): string | null {
  switch (token.type) {
    case "space":
      return null;
    case "heading":
      // Headings become bold lines (no leading '#'), Go parity.
      return `*${renderInline((token as Tokens.Heading).tokens)}*`;
    case "paragraph":
      return renderInline((token as Tokens.Paragraph).tokens);
    case "text": {
      const tt = token as Tokens.Text;
      return tt.tokens && tt.tokens.length ? renderInline(tt.tokens) : esc(decodeEntities(tt.text));
    }
    case "code": {
      const c = token as Tokens.Code;
      const lang = c.lang ? c.lang.split(/\s+/)[0] : "";
      return "```" + (lang ?? "") + "\n" + escCode(c.text) + "\n```";
    }
    case "blockquote": {
      const inner = renderBlocks((token as Tokens.Blockquote).tokens, depth);
      return inner
        .split("\n")
        .map((line) => ">" + line)
        .join("\n");
    }
    case "list":
      return renderList(token as Tokens.List, depth);
    case "hr":
      return esc("---");
    case "table":
      return renderTable(token as Tokens.Table);
    case "html":
      return null;
    default: {
      const anyTok = token as { tokens?: Token[]; text?: string };
      if (anyTok.tokens) return renderInline(anyTok.tokens);
      if (typeof anyTok.text === "string") return esc(decodeEntities(anyTok.text));
      return null;
    }
  }
}

/** GFM tables degrade to plain ` | `-separated rows; header cells are bold. */
function renderTable(tbl: Tokens.Table): string {
  const rows: string[] = [];
  rows.push(tbl.header.map((c) => `*${renderInline(c.tokens)}*`).join(" | "));
  for (const row of tbl.rows) {
    rows.push(row.map((c) => renderInline(c.tokens)).join(" | "));
  }
  return rows.join("\n");
}

/** Join top-level blocks. A list stays tight to the block before it (Go parity). */
function renderBlocks(tokens: Token[], depth: number): string {
  let out = "";
  let prevType: string | null = null;
  for (const tok of tokens) {
    const rendered = renderBlock(tok, depth);
    if (rendered === null || rendered === "") {
      if (tok.type !== "space") prevType = tok.type;
      continue;
    }
    if (out !== "") out += tok.type === "list" && prevType !== "list" ? "\n" : "\n\n";
    out += rendered;
    prevType = tok.type;
  }
  return out;
}

/**
 * Convert raw markdown (LLM output) to Telegram MarkdownV2. Used only on the
 * finalized reply — partial streaming chunks are sent as plain text (see stream.ts),
 * because raw markdown rarely parses as valid MarkdownV2 mid-stream.
 */
export function toTelegramMarkdown(md: string): string {
  const tokens = marked.lexer(md, { gfm: true, breaks: true });
  const out = renderBlocks(tokens, 0).replace(/\n{3,}/g, "\n\n").trim();
  log.debug({ inLen: md.length, outLen: out.length }, "markdown -> MarkdownV2");
  return out;
}

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
 * paragraph/line/word boundaries (search window 500, parity with Go split.go).
 * Returns [] for empty input.
 */
export function splitMessage(text: string, limit = TELEGRAM_MAX_MESSAGE_LEN): string[] {
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
