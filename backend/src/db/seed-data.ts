/**
 * Code-based seed data for DB-stored configuration.
 *
 * Replaces `backend/seed/config.yaml`. Skills and prompts are now a file store
 * (see `src/content/`), so the only data seeded into the DB is configuration
 * that genuinely belongs there: model roles, the available-models list, LLM
 * timeouts, agent params, and subscription plans. `.env` still holds secrets only.
 *
 * NOTE: dead Go config (`agent.rag.enabled`, `agent.memory_extraction.*`) is NOT
 * carried over — only values the app actually reads (parity with the Go review).
 */

/** Model role assignments (`provider:model` refs). */
export const SEED_MODEL_ROLES = {
  default: "openrouter:google/gemini-3.1-flash-lite",
  router: "openrouter:openai/gpt-oss-120b:nitro",
  embedding: "openrouter:intfloat/multilingual-e5-large",
  error_correction: "openrouter:google/gemini-3-flash-preview",
  speech: "openrouter:google/gemini-3.1-flash-lite",
  synthesizer: "openrouter:google/gemini-3-flash-preview",
} as const;

/** Available `provider:model` refs (UI list + role validation). */
export const SEED_MODELS: string[] = [
  // OpenRouter
  "openrouter:openai/gpt-oss-120b:nitro",
  "openrouter:openai/gpt-5-nano",
  "openrouter:google/gemini-3-flash-preview",
  "openrouter:google/gemini-3.1-flash-lite",
  "openrouter:deepseek/deepseek-v3.2",
  "openrouter:deepseek/deepseek-v4-flash:nitro",
  "openrouter:google/gemma-3-27b-it",
  "openrouter:qwen/qwen3.5-flash-02-23",
  "openrouter:minimax/minimax-m2.7",
  // Z.AI
  "zai:glm-5",
  "zai:glm-4.7-Flash",
];

/**
 * LLM-call timeouts (Go duration strings: "300s", "5m", "1h30m").
 * - `llm_request`  — overall budget for one LLM call (first request → last chunk).
 * - `http_client`  — provider HTTP client timeout; must be >= llm_request.
 * - `llm_activity` — watchdog silence window between chunks (reset per chunk).
 */
export const SEED_TIMEOUTS = {
  llm_request: "300s",
  http_client: "300s",
  llm_activity: "30s",
} as const;

/** Agent params actually read by the app (rag_top_k is now configurable, not hardcoded). */
export const SEED_AGENT = {
  max_history: 15,
  default_temperature: 0.4,
  rag_top_k: 10,
} as const;

/** Telegram chat allowlist — empty by default. */
export const SEED_TELEGRAM_ALLOWED_USERS: number[] = [];

/** Default subscription plans — parity with Go migrations 00013–00017. */
export const SEED_PLANS: { name: string; hourlyLimit: number; maxTasks: number }[] = [
  { name: "free", hourlyLimit: 15, maxTasks: 3 },
  { name: "pro", hourlyLimit: 50, maxTasks: 5 },
  { name: "admin", hourlyLimit: 100, maxTasks: 10 },
];
