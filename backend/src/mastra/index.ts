import { Mastra } from "@mastra/core";
import { LibSQLStore } from "@mastra/libsql";
import { env } from "../config/env.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "mastra" });

/** Mastra storage (threads/messages) backed by libSQL. */
export const storage = new LibSQLStore({
  id: "jarvis",
  url: env.LIBSQL_URL,
  authToken: env.LIBSQL_AUTH_TOKEN,
});

/**
 * Central Mastra instance. Agents/workflows are registered in later tasks.
 * `logger: false` — we use our own pino logger to avoid duplicate output.
 * Long-term memory lives in a plain relational table (loaded whole), not a vector
 * index — see MemoryService.
 */
export const mastra = new Mastra({
  storage,
  logger: false,
});

// Conversation-history memory is built by the composition root (`createChatService`
// in app.ts) from `settings.agent.max_history`, not here — that keeps a single live
// instance whose window reflects DB config rather than a hardcoded default.

log.info("mastra instance constructed (storage)");
