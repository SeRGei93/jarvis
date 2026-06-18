// Keys + value shapes for the `settings` table. Shared by the seed (writer)
// and SettingsService (reader) so they agree on the schema.

export const SettingKey = {
  ModelRoles: "model_roles",
  Timeouts: "timeouts",
  Agent: "agent",
  TelegramAllowedUsers: "telegram_allowed_users",
  TelegramAccessMode: "telegram_access_mode",
} as const;
export type SettingKey = (typeof SettingKey)[keyof typeof SettingKey];

/**
 * Bot access mode (`telegram_access_mode` setting).
 * - `open`     — legacy gate: empty allowlist = everyone, non-empty = only listed.
 * - `approval` — only ids in `telegram_allowed_users`; an unknown user's message
 *                creates an access request instead of being silently dropped.
 */
export type AccessMode = "open" | "approval";

export interface ModelRoles {
  default: string;
  router: string;
  error_correction: string;
  speech: string;
  synthesizer: string;
}

/** Go duration strings (e.g. "300s", "30s") — parsed where consumed. */
export interface TimeoutsConfig {
  llm_request: string;
  http_client: string;
  llm_activity: string;
}

export interface AgentConfig {
  max_history: number;
  default_temperature: number;
  /**
   * Opportunistic long-term memory: when on, after each turn an extractor may
   * save durable facts the user stated in passing (in addition to the explicit
   * `remember` tool + onboarding). Undefined is treated as ON by consumers
   * (older DB rows predate this key). A deliberate divergence from Go parity.
   */
  auto_memory?: boolean;
}
