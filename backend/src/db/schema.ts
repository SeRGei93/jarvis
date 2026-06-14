import { sql } from "drizzle-orm";
import {
  sqliteTable,
  integer,
  text,
  real,
  primaryKey,
  unique,
  index,
} from "drizzle-orm/sqlite-core";

// libSQL/SQLite has no DECIMAL/TIMESTAMPTZ/BOOLEAN — we map:
//   timestamps -> integer (epoch seconds, drizzle `timestamp` mode)
//   booleans   -> integer 0/1 (drizzle `boolean` mode)
//   DECIMAL    -> real (usage_stats.cost)
//   DATE       -> text 'YYYY-MM-DD'
const createdAt = () =>
  integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`);
const updatedAt = () =>
  integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`);

// ── users ───────────────────────────────────────────────────────────────
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().default(""),
  displayName: text("display_name").notNull().default(""),
  city: text("city").notNull().default(""),
  timezone: text("timezone").notNull().default(""),
  language: text("language").notNull().default(""),
  onboarded: integer("onboarded", { mode: "boolean" }).notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ── user_channels ─────────────────────────────────────────────────────────
export const userChannels = sqliteTable(
  "user_channels",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("uq_user_channels_provider_external").on(t.provider, t.externalId),
    index("idx_user_channels_user").on(t.userId),
  ],
);

// ── sessions ──────────────────────────────────────────────────────────────
// thread_id links a session to its Mastra Memory thread (set in Task 23).
export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id").notNull().unique(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  threadId: text("thread_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ── memories ────────────────────────────────────────────────────────────────
// Embedding vectors live in the LibSQLVector index `memories_vec` (Task 6),
// keyed by memory id with metadata {memoryId, userId, scope, category}.
export const memories = sqliteTable(
  "memories",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    scope: text("scope").notNull().default("permanent"),
    sessionId: integer("session_id").references(() => sessions.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_memories_user").on(t.userId),
    index("idx_memories_session").on(t.sessionId),
    index("idx_memories_scope").on(t.scope),
  ],
);

// ── bot_identities ──────────────────────────────────────────────────────────
export const botIdentities = sqliteTable("bot_identities", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  botName: text("bot_name").notNull().default(""),
  vibe: text("vibe").notNull().default(""),
  systemPromptOverride: text("system_prompt_override").notNull().default(""),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ── cron_tasks ──────────────────────────────────────────────────────────────
export const cronTasks = sqliteTable(
  "cron_tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: integer("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    prompt: text("prompt").notNull().default(""),
    skillName: text("skill_name").notNull().default(""),
    schedule: text("schedule").notNull().default(""),
    scheduledAt: integer("scheduled_at", { mode: "timestamp" }),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    lastRunAt: integer("last_run_at", { mode: "timestamp" }),
    lastRunStatus: text("last_run_status"),
    lastRunError: text("last_run_error"),
    notificationChatId: integer("notification_chat_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("idx_cron_tasks_user").on(t.userId),
    index("idx_cron_tasks_session").on(t.sessionId),
    index("idx_cron_tasks_active").on(t.isActive),
    index("idx_cron_tasks_scheduled").on(t.scheduledAt),
  ],
);

// ── usage_stats ─────────────────────────────────────────────────────────────
export const usageStats = sqliteTable(
  "usage_stats",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    date: text("date").notNull(), // 'YYYY-MM-DD'
    cost: real("cost").notNull().default(0),
    requests: integer("requests").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("uq_usage_stats_user_date").on(t.userId, t.date),
    index("idx_usage_stats_user_date").on(t.userId, t.date),
  ],
);

// ── subscription_plans ──────────────────────────────────────────────────────
export const subscriptionPlans = sqliteTable("subscription_plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  hourlyLimit: integer("hourly_limit").notNull(),
  maxTasks: integer("max_tasks").notNull().default(3),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ── user_subscriptions ──────────────────────────────────────────────────────
export const userSubscriptions = sqliteTable("user_subscriptions", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  planId: integer("plan_id")
    .notNull()
    .references(() => subscriptionPlans.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ── message_rate_limits ─────────────────────────────────────────────────────
// Sliding-window counter, window_start truncated to the hour.
export const messageRateLimits = sqliteTable(
  "message_rate_limits",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    windowStart: integer("window_start", { mode: "timestamp" }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.windowStart] })],
);

// ══════════════════════════════════════════════════════════════════════════
// Configuration tables (new in the TS rewrite — config moves from config.yaml
// /skills/prompts files into the DB, editable via the admin Mini App). §3 ROADMAP.
// ══════════════════════════════════════════════════════════════════════════

// ── settings ────────────────────────────────────────────────────────────────
// Global config as key -> JSON value: model roles (default/router/embedding/
// error_correction/speech/synthesizer), timeouts.*, agent.* (max_history,
// default_temperature, rag.top_k), telegram.allowed_users, mcp_servers (search only).
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: updatedAt(),
});

// ── models ──────────────────────────────────────────────────────────────────
// Available `provider:model` refs for UI + role validation.
export const models = sqliteTable("models", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  ref: text("ref").notNull().unique(),
  provider: text("provider").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  label: text("label").notNull().default(""),
  supportsTools: integer("supports_tools", { mode: "boolean" }).notNull().default(true),
  supportsReasoning: integer("supports_reasoning", { mode: "boolean" }).notNull().default(false),
  notes: text("notes").notNull().default(""),
  updatedAt: updatedAt(),
});

// ── skills ──────────────────────────────────────────────────────────────────
// One row per skill (seeded from skills/*/SKILL.md). reasoning is tri-state:
// null = provider default, false = disabled, true = enabled. temperature null =
// fall back to agent.default_temperature.
export const skills = sqliteTable("skills", {
  name: text("name").primaryKey(),
  description: text("description").notNull().default(""),
  allowedTools: text("allowed_tools", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`),
  model: text("model").notNull().default(""),
  temperature: real("temperature"),
  reasoning: integer("reasoning", { mode: "boolean" }),
  routable: integer("routable", { mode: "boolean" }).notNull().default(true),
  prompt: text("prompt").notNull().default(""),
  metadata: text("metadata", { mode: "json" })
    .$type<Record<string, string>>()
    .notNull()
    .default(sql`'{}'`),
  updatedAt: updatedAt(),
});

// ── prompts ─────────────────────────────────────────────────────────────────
// System prompts: SOUL/FORMAT/INTEGRITY/SYNTHESIZER/WELCOME/MONITORING.
export const prompts = sqliteTable("prompts", {
  key: text("key").primaryKey(),
  body: text("body").notNull().default(""),
  updatedAt: updatedAt(),
});
