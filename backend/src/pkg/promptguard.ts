import { logger } from "./logger.js";

const log = logger.child({ mod: "promptguard" });

// Length limits (in code points) — parity with Go constraints.go.
export const MAX_USER_MESSAGE_LEN = 4096; // Telegram message limit
export const MAX_TASK_PROMPT_LEN = 4096;
export const MAX_MEMORY_CONTENT_LEN = 500;
export const MAX_PROFILE_FIELD_LEN = 100;
export const MAX_SYSTEM_PROMPT_LEN = 1024;

// Phrases that suggest a prompt-injection attempt (matched case-insensitively).
const INJECTION_PATTERNS = [
  "ignore previous",
  "ignore all previous",
  "ignore all instructions",
  "disregard previous",
  "forget all instructions",
  "forget your instructions",
  "new instructions:",
  "system:",
  "assistant:",
  "you are now",
  "pretend you are",
  "act as if",
  "override your",
];

// Subset of ISO 639-1 codes accepted for the user's language preference.
const COMMON_LANGUAGES = new Set([
  "ru", "en", "de", "fr", "es", "it", "pl", "uk", "be", "zh", "ja", "ko", "pt",
  "nl", "tr", "ar", "hi", "id", "vi", "th", "sv", "no", "da", "fi", "el",
]);

// Code-point-aware helpers (parity with Go's rune handling).
function runeLength(s: string): number {
  return [...s].length;
}
function runeSlice(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

// Zero-width / invisible characters that attackers slip between letters to
// defeat substring matching (e.g. "ig[ZWSP]nore previous").
//   U+200B zero-width space, U+200C ZWNJ, U+200D ZWJ, U+2060 word joiner,
//   U+FEFF BOM / zero-width no-break space, U+00AD soft hyphen.
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\u2060\uFEFF\u00AD]/gu;
// C0 (U+0000–U+001F) and C1 (U+007F–U+009F) control characters, KEEPING
// newline (U+000A) and tab (U+0009) which are legitimate in user text.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu;

/**
 * Normalize text for guardrail matching (no LLM):
 *  1. NFKC — folds fullwidth / compatibility homoglyphs (e.g. "ｉ" → "i").
 *  2. Strip zero-width / invisible characters used to split injection phrases.
 *  3. Remove C0/C1 control chars except `\n` and `\t`.
 * Used by validateUserMessage so containsInjection runs on a canonical form.
 */
export function normalizeForGuard(s: string): string {
  return s
    .normalize("NFKC")
    .replace(ZERO_WIDTH_RE, "")
    .replace(CONTROL_CHARS_RE, "");
}

// --- PII redaction (output guardrail) ---------------------------------------
// Applied to memory content BEFORE it is stored. Each match → "[redacted]".

// Email: local-part@domain.tld. Conservative; allows the usual local-part chars.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Credit-card-like run: 13–19 digits, optionally grouped by single spaces or
// hyphens. Anchored on digit boundaries so we don't eat part of a longer number.
// Requiring ≥13 digits keeps ordinary years/prices/short IDs out of scope.
const CARD_RE = /(?<![\d-])(?:\d[ -]?){13,19}(?![\d-])/g;
// Phone: optional leading "+", then 7+ digits with optional spaces, hyphens,
// dots or parentheses between groups. Matches "+375 29 123-45-67", "1234567",
// "(017) 123-45-67". A ≥7-digit floor avoids redacting short years/prices.
const PHONE_RE = /\+?\d[\d().\s-]{5,}\d/g;

/** Count the digits in a string (helper for the conservative card check). */
function digitCount(s: string): number {
  return (s.match(/\d/g) ?? []).length;
}

/**
 * Redact PII (emails, credit-card-like digit runs, phone numbers) from text,
 * replacing each match with "[redacted]". Order matters: emails first (so the
 * digit-heavy patterns don't chew through an address), then cards (the more
 * specific ≥13-digit run), then phones (the looser ≥7-digit fallback).
 */
function redactPii(s: string): string {
  let out = s.replace(EMAIL_RE, "[redacted]");
  // Cards: only redact when the run actually carries 13–19 digits (the regex
  // separators can otherwise let a shorter/longer match slip through).
  out = out.replace(CARD_RE, (m) => {
    const n = digitCount(m);
    return n >= 13 && n <= 19 ? "[redacted]" : m;
  });
  // Phones: require ≥7 digits so we don't redact short years/prices.
  out = out.replace(PHONE_RE, (m) => (digitCount(m) >= 7 ? "[redacted]" : m));
  return out;
}

/** Redact PII, then trim and truncate memory content to MAX_MEMORY_CONTENT_LEN (adds "…" if cut). */
export function sanitizeMemoryContent(s: string): string {
  const redacted = redactPii(s);
  if (redacted !== s) log.debug("redacted PII from memory content");
  const t = redacted.trim();
  if (runeLength(t) <= MAX_MEMORY_CONTENT_LEN) return t;
  const out = runeSlice(t, MAX_MEMORY_CONTENT_LEN) + "…";
  log.debug({ inLen: runeLength(s), outLen: runeLength(out) }, "sanitized memory content (truncated)");
  return out;
}

/** Trim and truncate a profile field (name/vibe/etc.) — no ellipsis (parity). */
export function sanitizeProfileField(s: string, maxLen = MAX_PROFILE_FIELD_LEN): string {
  const t = s.trim();
  const lim = maxLen > 0 ? maxLen : MAX_PROFILE_FIELD_LEN;
  return runeLength(t) <= lim ? t : runeSlice(t, lim);
}

/** Truncate context text, appending "…" when cut. */
export function truncateForContext(s: string, maxLen: number): string {
  return runeLength(s) <= maxLen ? s : runeSlice(s, maxLen) + "…";
}

/** True if the text contains a suspicious injection phrase. */
export function containsInjection(s: string): boolean {
  const lower = s.toLowerCase();
  for (const p of INJECTION_PATTERNS) {
    if (lower.includes(p)) {
      log.warn({ pattern: p }, "injection pattern matched");
      return true;
    }
  }
  return false;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; userMessage: string };

/** Validate an incoming user message (length + injection). Base version; full guard in M4. */
export function validateUserMessage(s: string, maxLen = MAX_USER_MESSAGE_LEN): ValidationResult {
  const lim = maxLen > 0 ? maxLen : MAX_USER_MESSAGE_LEN;
  // Length is measured on the ORIGINAL string (Telegram counts what the user typed).
  if (runeLength(s) > lim) {
    return {
      ok: false,
      reason: "message exceeds max length",
      userMessage: `Сообщение слишком длинное. Максимум — ${lim} символов.`,
    };
  }
  // Injection check runs on the NORMALIZED form so homoglyph / zero-width /
  // control-char obfuscation ("ｉgnore previous", "ig[ZWSP]nore previous") is caught.
  if (containsInjection(normalizeForGuard(s))) {
    return {
      ok: false,
      reason: "prompt injection detected",
      userMessage: "Сообщение содержит недопустимое содержимое. Переформулируйте, пожалуйста.",
    };
  }
  return { ok: true };
}

export function validateProfileFieldLength(s: string, maxLen = MAX_PROFILE_FIELD_LEN): boolean {
  const lim = maxLen > 0 ? maxLen : MAX_PROFILE_FIELD_LEN;
  return runeLength(s) <= lim;
}

/** True for a known ISO 639-1 code or empty (= not set). */
export function validateLanguage(s: string): boolean {
  const t = s.trim().toLowerCase();
  return t === "" || COMMON_LANGUAGES.has(t);
}

/** True for a valid IANA timezone or empty (= not set). */
export function validateTimezone(s: string): boolean {
  const t = s.trim();
  if (t === "") return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: t });
    return true;
  } catch {
    return false;
  }
}
