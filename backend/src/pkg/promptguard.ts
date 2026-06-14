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

/** Trim and truncate memory content to MAX_MEMORY_CONTENT_LEN (adds "…" if cut). */
export function sanitizeMemoryContent(s: string): string {
  const t = s.trim();
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
  if (runeLength(s) > lim) {
    return {
      ok: false,
      reason: "message exceeds max length",
      userMessage: `Сообщение слишком длинное. Максимум — ${lim} символов.`,
    };
  }
  if (containsInjection(s)) {
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
