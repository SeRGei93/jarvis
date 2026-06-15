// Keys + value shapes for the `settings` table. Shared by the seed (writer)
// and SettingsService (reader) so they agree on the schema.

export const SettingKey = {
  ModelRoles: "model_roles",
  Timeouts: "timeouts",
  Agent: "agent",
  TelegramAllowedUsers: "telegram_allowed_users",
} as const;
export type SettingKey = (typeof SettingKey)[keyof typeof SettingKey];

export interface ModelRoles {
  default: string;
  router: string;
  embedding: string;
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
  rag_top_k: number;
}
