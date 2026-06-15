// Entity types mirroring backend/src/db/schema.ts and config/settings-keys.ts.
// Timestamps arrive as JSON: drizzle `timestamp` columns serialize to numbers
// (epoch ms) or ISO strings depending on the driver — we keep them loose.

export type Timestamp = number | string;

// ── skills (skills table) ───────────────────────────────────────────────────
export interface Skill {
  name: string;
  description: string;
  allowedTools: string[];
  model: string;
  /** null = fall back to agent.default_temperature */
  temperature: number | null;
  /** tri-state: null = provider default, false = off, true = on */
  reasoning: boolean | null;
  routable: boolean;
  prompt: string;
  metadata: Record<string, string>;
  updatedAt: Timestamp;
}

// ── models (models table) ───────────────────────────────────────────────────
export interface ModelRow {
  id: number;
  ref: string;
  provider: string;
  enabled: boolean;
  label: string;
  supportsTools: boolean;
  supportsReasoning: boolean;
  notes: string;
  updatedAt: Timestamp;
}

// ── model roles (settings: model_roles) ─────────────────────────────────────
export interface ModelRoles {
  default: string;
  router: string;
  embedding: string;
  error_correction: string;
  speech: string;
  synthesizer: string;
}

// ── timeouts (settings: timeouts) — Go-duration strings ─────────────────────
export interface SettingsTimeouts {
  llm_request: string;
  http_client: string;
  llm_activity: string;
}

// ── agent params (settings: agent) ──────────────────────────────────────────
export interface AgentConfig {
  max_history: number;
  default_temperature: number;
  rag_top_k: number;
}

// ── prompts (prompts table) ─────────────────────────────────────────────────
export interface Prompt {
  key: string;
  body: string;
  updatedAt: Timestamp;
}

// ── users (users table) ─────────────────────────────────────────────────────
export interface User {
  id: number;
  name: string;
  displayName: string;
  city: string;
  timezone: string;
  language: string;
  onboarded: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ── subscription plans (subscription_plans table) ───────────────────────────
export interface Plan {
  id: number;
  name: string;
  hourlyLimit: number;
  maxTasks: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ── usage stats (usage_stats table) ─────────────────────────────────────────
export interface UsageRow {
  id: number;
  userId: number;
  /** 'YYYY-MM-DD' */
  date: string;
  cost: number;
  requests: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** Mutation envelope returned by admin write endpoints: { ok: true, value? }. */
export interface MutationResult<T = unknown> {
  ok: boolean;
  value?: T;
}
