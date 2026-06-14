import "./bootstrap-env.js";
import { pino, type Logger } from "pino";

const isProd = process.env.NODE_ENV === "production";
const level = process.env.LOG_LEVEL ?? (isProd ? "info" : "debug");

// Never log secrets (CLAUDE.md security rule). Redact common secret-bearing keys
// wherever they appear in a log object (top level or one level deep).
const REDACT_PATHS = [
  "authorization",
  "Authorization",
  "*.authorization",
  "*.Authorization",
  "headers.authorization",
  "headers.Authorization",
  "token",
  "*.token",
  "apiKey",
  "*.apiKey",
  "api_key",
  "*.api_key",
  "TELEGRAM_BOT_TOKEN",
  "*.TELEGRAM_BOT_TOKEN",
  "OPENROUTER_API_KEY",
  "*.OPENROUTER_API_KEY",
  "ZAI_API_KEY",
  "*.ZAI_API_KEY",
  "OPENAI_API_KEY",
  "*.OPENAI_API_KEY",
  "XAI_API_KEY",
  "*.XAI_API_KEY",
  "GOOGLE_API_KEY",
  "*.GOOGLE_API_KEY",
  "LIBSQL_AUTH_TOKEN",
  "*.LIBSQL_AUTH_TOKEN",
];

export const logger: Logger = pino({
  level,
  redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  // Pretty output in dev; raw structured JSON (one line per event) in prod.
  ...(isProd
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss.l",
            ignore: "pid,hostname",
          },
        },
      }),
});

logger.info({ level, mode: isProd ? "prod" : "dev" }, "logger initialized");

/**
 * Child logger carrying contextual bindings (e.g. trace_id, session_id, user_id).
 * Analogous to Go's `slog.With(...)`.
 */
export function withContext(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings);
}
