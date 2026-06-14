import "../pkg/bootstrap-env.js";
import { z } from "zod";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "env" });

/**
 * `.env` holds ONLY secrets + runtime flags. All other configuration
 * (model roles, timeouts, agent params, skills, prompts, plans, MCP servers)
 * lives in the database (see SettingsService). See ROADMAP §4.
 */
const EnvSchema = z.object({
  // libSQL / Turso
  LIBSQL_URL: z.string().min(1).default("file:./data/avocado.db"),
  LIBSQL_AUTH_TOKEN: z.string().optional(), // only for Turso

  // Telegram
  TELEGRAM_BOT_TOKEN: z.string().optional(),

  // LLM providers
  OPENROUTER_API_KEY: z.string().optional(),
  ZAI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  XAI_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),

  // Admin (Mini App bootstrap): comma-separated Telegram user ids
  ADMIN_USER_IDS: z.string().default(""),

  // Runtime
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema> & {
  /** Parsed numeric admin ids from ADMIN_USER_IDS. */
  adminUserIds: number[];
};

// Secrets that MUST be present in production — fail-fast on boot if missing.
const REQUIRED_IN_PROD = ["TELEGRAM_BOT_TOKEN", "OPENROUTER_API_KEY"] as const;

function parseEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    log.error({ issues: parsed.error.issues }, "invalid environment configuration");
    const summary = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${summary}`);
  }
  const e = parsed.data;

  if (e.NODE_ENV === "production") {
    const missing = REQUIRED_IN_PROD.filter((k) => !e[k]);
    if (missing.length > 0) {
      log.error({ missing }, "missing required secrets in production");
      throw new Error(`Missing required secrets in production: ${missing.join(", ")}`);
    }
  }

  const adminUserIds = e.ADMIN_USER_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n));

  // DEBUG: report which keys are present by NAME only — never values.
  const present = Object.entries(e)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k]) => k);
  log.debug({ present, adminCount: adminUserIds.length }, "environment validated");

  return { ...e, adminUserIds };
}

/** Validated environment, loaded once at import. */
export const env: Env = parseEnv();
