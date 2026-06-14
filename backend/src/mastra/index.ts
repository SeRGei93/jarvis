import { Mastra } from "@mastra/core";
import { LibSQLStore, LibSQLVector } from "@mastra/libsql";
import { createConversationMemory } from "./memory/history.js";
import { env } from "../config/env.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "mastra" });

/** Mastra storage (threads/messages/working-memory) backed by libSQL. */
export const storage = new LibSQLStore({
  id: "jarvis",
  url: env.LIBSQL_URL,
  authToken: env.LIBSQL_AUTH_TOKEN,
});

/** Vector store for long-term memory RAG (index `memories_vec`, 1024-dim). */
export const vector = new LibSQLVector({
  url: env.LIBSQL_URL,
  authToken: env.LIBSQL_AUTH_TOKEN,
  id: "memories",
});

/**
 * Central Mastra instance. Agents/workflows are registered in later tasks.
 * `logger: false` — we use our own pino logger to avoid duplicate output.
 */
export const mastra = new Mastra({
  storage,
  vectors: { memories: vector },
  logger: false,
});

/**
 * Conversation-history memory (libSQL, plaintext). lastMessages defaults to 15;
 * the composition root rebuilds it from settings.agent.max_history at startup.
 */
export const conversationMemory = createConversationMemory(storage, 15);

log.info("mastra instance constructed (storage + vector + memory)");
