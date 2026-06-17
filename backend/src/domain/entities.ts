import { z } from "zod";

// ══════════════════════════════════════════════════════════════════════════
// Invariant constants.
// ══════════════════════════════════════════════════════════════════════════
/** Max permanent memories kept per user (oldest trimmed beyond this). */
export const MAX_PERMANENT_MEMORIES = 50;
/** Auto-complete onboarding once a user has sent this many messages. */
export const ONBOARDING_MESSAGE_THRESHOLD = 4;

// ══════════════════════════════════════════════════════════════════════════
// Enums
// ══════════════════════════════════════════════════════════════════════════
/**
 * Long-term memory categories.
 * - Active (written by `remember` + onboarding + the opportunistic `FactExtractor`):
 *   `preference`, `fact`, `instruction`, `lesson`.
 * - Reserved meta-insight categories: `reflection`, `strategy`. Valid and classified
 *   as permanent; rendered with a "(learned <date>)" suffix in the system prompt.
 *   No writer auto-produces them — the opportunistic extractor stays conservative on
 *   the four concrete categories to avoid vague auto-generated entries. They remain
 *   available for explicit/future use rather than being removed.
 */
export const MemoryCategory = z.enum([
  "preference",
  "fact",
  "instruction",
  "lesson",
  "reflection",
  "strategy",
]);
export type MemoryCategory = z.infer<typeof MemoryCategory>;

export const MemoryScope = z.enum(["permanent", "session"]);
export type MemoryScope = z.infer<typeof MemoryScope>;

export const MessageRole = z.enum(["user", "assistant", "system"]);
export type MessageRole = z.infer<typeof MessageRole>;

// ══════════════════════════════════════════════════════════════════════════
// Entities
// ══════════════════════════════════════════════════════════════════════════
export const User = z.object({
  id: z.number().int(),
  name: z.string().default(""),
  displayName: z.string().default(""),
  city: z.string().default(""),
  timezone: z.string().default(""),
  language: z.string().default(""),
  onboarded: z.boolean().default(false),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});
export type User = z.infer<typeof User>;

export const UserChannel = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  provider: z.string(),
  externalId: z.string(),
  createdAt: z.date().optional(),
});
export type UserChannel = z.infer<typeof UserChannel>;

export const Session = z.object({
  id: z.number().int(),
  chatId: z.number().int(),
  userId: z.number().int().nullable().optional(),
  model: z.string(),
  /** Mastra Memory thread id (null until a thread is created). */
  threadId: z.string().nullable().optional(),
  /** Rolling summary of dialogue history evicted beyond the max_history window. */
  summary: z.string().nullable().optional(),
  /** How many of the thread's oldest messages `summary` already covers. */
  summaryMsgCount: z.number().int().default(0),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});
export type Session = z.infer<typeof Session>;

export const Memory = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  category: MemoryCategory,
  scope: MemoryScope,
  sessionId: z.number().int().nullable().optional(),
  content: z.string(),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});
export type Memory = z.infer<typeof Memory>;

export const BotIdentity = z.object({
  userId: z.number().int(),
  botName: z.string().default(""),
  vibe: z.string().default(""),
  systemPromptOverride: z.string().default(""),
});
export type BotIdentity = z.infer<typeof BotIdentity>;

export const Skill = z.object({
  name: z.string(),
  description: z.string().default(""),
  allowedTools: z.array(z.string()).default([]),
  model: z.string().default(""),
  /** null -> use agent.default_temperature. */
  temperature: z.number().nullable().optional(),
  /** Tri-state: null -> provider default, false -> off, true -> on. */
  reasoning: z.boolean().nullable().optional(),
  /** false -> cron-only, not offered to the router. */
  routable: z.boolean().default(true),
  prompt: z.string().default(""),
  metadata: z.record(z.string(), z.string()).default({}),
});
export type Skill = z.infer<typeof Skill>;

export const CronTask = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  sessionId: z.number().int(),
  name: z.string(),
  description: z.string().default(""),
  prompt: z.string().default(""),
  skillName: z.string().default(""),
  schedule: z.string().default(""),
  scheduledAt: z.date().nullable().optional(),
  isActive: z.boolean().default(true),
  lastRunAt: z.date().nullable().optional(),
  lastRunStatus: z.string().nullable().optional(),
  lastRunError: z.string().nullable().optional(),
  notificationChatId: z.number().int().nullable().optional(),
  createdAt: z.date().optional(),
  updatedAt: z.date().optional(),
});
export type CronTask = z.infer<typeof CronTask>;

export const UsageStat = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  date: z.string(), // 'YYYY-MM-DD'
  cost: z.number().default(0),
  requests: z.number().int().default(0),
});
export type UsageStat = z.infer<typeof UsageStat>;

export const SubscriptionPlan = z.object({
  id: z.number().int(),
  name: z.string(),
  hourlyLimit: z.number().int(),
  maxTasks: z.number().int().default(3),
});
export type SubscriptionPlan = z.infer<typeof SubscriptionPlan>;

/** A conversation message. `skill` tags which skill produced an assistant reply. */
export const Message = z.object({
  role: MessageRole,
  content: z.string(),
  skill: z.string().nullable().optional(),
  createdAt: z.date().optional(),
});
export type Message = z.infer<typeof Message>;

// ══════════════════════════════════════════════════════════════════════════
// Domain helpers (entity-owned business logic, parity with Go entities)
// ══════════════════════════════════════════════════════════════════════════
/** Onboarding ("preference") facts are always loaded, never RAG-gated. */
export function isOnboarding(m: Pick<Memory, "category">): boolean {
  return m.category === "preference";
}

export function isRegularFact(m: Pick<Memory, "category">): boolean {
  return m.category !== "preference";
}

/** Parity with Go User.ShouldAutoCompleteOnboarding. */
export function shouldAutoCompleteOnboarding(onboarded: boolean, messageCount: number): boolean {
  return !onboarded && messageCount >= ONBOARDING_MESSAGE_THRESHOLD;
}
