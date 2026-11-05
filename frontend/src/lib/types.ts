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

// ── model catalog (backend /models/catalog) ─────────────────────────────────
/** One selectable model from the OpenRouter catalog or the curated decision list. */
export interface CatalogRow {
  /** `provider:model` ref written into a role. */
  ref: string;
  /** Provider-side id (what the provider expects on the wire). */
  id: string;
  /** Human title — the client-side search matches this. */
  name: string;
  contextLength: number | null;
  /** USD per 1M tokens. */
  pricingIn: number | null;
  pricingOut: number | null;
  supportsTools: boolean;
  supportsReasoning: boolean;
  /** Decision list only: the id is an alias tracking the current release. */
  aliased?: boolean;
  /** Decision list only: UI hint. */
  note?: string;
}

/** `stale` = the backend served its last known list after a failed refresh. */
export interface CatalogResponse {
  items: CatalogRow[];
  stale: boolean;
}

// ── model roles (settings: model_roles) ─────────────────────────────────────
export interface ModelRoles {
  default: string;
  router: string;
  error_correction: string;
  speech: string;
  synthesizer: string;
  /** Fast typed decisions (System One). Empty/absent = decision layer off. */
  decision?: string;
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
  /** Opportunistic long-term memory (auto-save durable facts). Default on. */
  auto_memory: boolean;
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

// ── bot access (settings: telegram_access_mode + access_requests table) ──────
/** `open` = empty allowlist means everyone; `approval` = only listed, others request. */
export type AccessMode = "open" | "approval";

/** A pending "let me into the bot" request shown in the admin inbox (M17). */
export interface AccessRequest {
  id: number;
  tgUserId: number;
  name: string;
  username: string | null;
  status: string;
  createdAt: Timestamp;
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

// ── cron tasks (cron_tasks table) ───────────────────────────────────────────
// Every row is created by the assistant via the `automation` skill (its
// `task_create` tool); there is no admin/human insert path. The admin app lists
// them, toggles `is_active`, and deletes — creation/editing stays with the agent.
export interface CronTask {
  id: number;
  userId: number;
  sessionId: number;
  name: string;
  description: string;
  /** Skill that *executes* the task (the sub-agent), not how it was created. */
  skillName: string;
  /** cron expression | "once" | "now" */
  schedule: string;
  /** epoch ms | null (set for "once" tasks) */
  scheduledAt: Timestamp | null;
  isActive: boolean;
  /** "success" | "error" | null */
  lastRunStatus: string | null;
  lastRunError: string | null;
  lastRunAt: Timestamp | null;
  notificationChatId: number | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  user: { id: number; name: string; displayName: string };
}

// ── MCP servers (settings: mcp_servers) ────────────────────────────────────
// Admin-managed HTTP MCP servers. The raw config is stored as-is (with `${VAR}`
// placeholders), so header secrets can stay in `.env` on the server.
export interface McpServerConfig {
  /** Transport discriminator; only "http" (Streamable HTTP) is supported. */
  type?: "http";
  url: string;
  headers?: Record<string, string>;
  /** false = stored but not connected. */
  enabled?: boolean;
  /** Per-tool-call timeout in ms (backend default 60000). */
  timeoutMs?: number;
  /** Optional SDK host allowlist. */
  allowedHosts?: string[];
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/** One server row from a live refresh or a `/mcp/test` probe. */
export interface McpServerStatus {
  name: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  /** Namespaced tool names (`<server>_<tool>`). */
  tools: string[];
  error?: string;
  durationMs?: number;
}

/** GET /admin/api/mcp */
export interface McpStatusResponse {
  config: McpConfig;
  ready: boolean;
  refreshing: boolean;
  status: McpServerStatus[];
}

/** PUT /admin/api/mcp */
export interface McpSaveResponse extends McpStatusResponse {
  ok: boolean;
  warnings: string[];
}

/** POST /admin/api/mcp/test */
export interface McpTestResponse {
  ok: boolean;
  status: McpServerStatus[];
  warnings: string[];
}

/** Mutation envelope returned by admin write endpoints: { ok: true, value? }. */
export interface MutationResult<T = unknown> {
  ok: boolean;
  value?: T;
}
