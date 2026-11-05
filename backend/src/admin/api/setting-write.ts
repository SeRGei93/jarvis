import { settings } from "../../db/schema.js";
import type { AdminEnv } from "./deps.js";

/**
 * Upsert a settings row (insert or replace value) — bumps `updatedAt` so the
 * `SettingsService` hot-reload version changes. Shared by the settings and MCP
 * routers.
 */
export async function upsertSetting(
  db: AdminEnv["Variables"]["deps"]["db"],
  key: string,
  value: unknown,
): Promise<void> {
  const now = new Date();
  await db
    .insert(settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
}
