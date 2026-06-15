import { max } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../db/schema.js";
import { settings, models as modelsTable } from "../db/schema.js";
import {
  SettingKey,
  type ModelRoles,
  type TimeoutsConfig,
  type AgentConfig,
} from "./settings-keys.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "settings" });

type Db = LibSQLDatabase<typeof schema>;
type ModelRow = typeof modelsTable.$inferSelect;

/** Parse a Go-style duration string ("300s", "1h30m", "500ms") into milliseconds. */
export function parseGoDuration(s: string): number {
  if (!s) return 0;
  const units: Record<string, number> = {
    ns: 1e-6,
    µs: 1e-3,
    us: 1e-3,
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
  };
  const re = /(\d+(?:\.\d+)?)\s*(ns|µs|us|ms|s|m|h)/g;
  let ms = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    ms += parseFloat(m[1]!) * units[m[2]!]!;
    matched = true;
  }
  return matched ? ms : 0;
}

function defaultTimeouts(): TimeoutsConfig {
  return { llm_request: "300s", http_client: "300s", llm_activity: "30s" };
}
function defaultAgent(): AgentConfig {
  return { max_history: 15, default_temperature: 0.4 };
}
function epochSeconds(d: Date | number | null | undefined): number {
  if (d == null) return 0;
  return d instanceof Date ? Math.floor(d.getTime() / 1000) : Number(d);
}

/**
 * Reads global config (settings + models) from the DB and caches it in memory.
 * Hot-reload: `refreshIfStale()` reloads when the DB has newer rows (max updated_at),
 * `invalidate()` forces a reload on next access (call after an admin save).
 */
export class SettingsService {
  private cache: Map<string, unknown> | null = null;
  private modelRows: ModelRow[] = [];
  private version = 0; // max(updated_at), epoch seconds

  constructor(private readonly db: Db) {}

  async reload(): Promise<void> {
    const rows = await this.db.select().from(settings);
    this.cache = new Map(rows.map((r) => [r.key, r.value]));
    this.version = rows.reduce((mx, r) => Math.max(mx, epochSeconds(r.updatedAt)), 0);
    this.modelRows = await this.db.select().from(modelsTable);
    log.info(
      { version: this.version, settings: rows.length, models: this.modelRows.length },
      "settings reloaded",
    );
    this.validate();
  }

  /** Drop the cache so the next access reloads (e.g. after an admin save). */
  invalidate(): void {
    this.cache = null;
    log.debug("settings cache invalidated");
  }

  /** Reload only if the DB has settings newer than the cached version. */
  async refreshIfStale(): Promise<void> {
    if (!this.cache) {
      await this.reload();
      return;
    }
    const res = await this.db.select({ v: max(settings.updatedAt) }).from(settings);
    const dbVersion = epochSeconds(res[0]?.v ?? null);
    if (dbVersion > this.version) {
      log.debug({ from: this.version, to: dbVersion }, "settings stale, reloading");
      await this.reload();
    }
  }

  private async ensure(): Promise<Map<string, unknown>> {
    if (!this.cache) {
      log.debug("settings cache miss");
      await this.reload();
    } else {
      log.debug("settings cache hit");
    }
    return this.cache!;
  }

  async getModelRoles(): Promise<ModelRoles> {
    return ((await this.ensure()).get(SettingKey.ModelRoles) ?? {}) as ModelRoles;
  }
  async getTimeouts(): Promise<TimeoutsConfig> {
    return ((await this.ensure()).get(SettingKey.Timeouts) ?? defaultTimeouts()) as TimeoutsConfig;
  }
  async getAgent(): Promise<AgentConfig> {
    return ((await this.ensure()).get(SettingKey.Agent) ?? defaultAgent()) as AgentConfig;
  }
  async getAllowedUsers(): Promise<number[]> {
    return ((await this.ensure()).get(SettingKey.TelegramAllowedUsers) ?? []) as number[];
  }
  async getModels(): Promise<ModelRow[]> {
    await this.ensure();
    return this.modelRows;
  }

  /** Warn (parity with Go) if http_client < llm_request — HTTP would abort first. */
  private validate(): void {
    const t = (this.cache?.get(SettingKey.Timeouts) ?? null) as TimeoutsConfig | null;
    if (!t) return;
    const http = parseGoDuration(t.http_client);
    const req = parseGoDuration(t.llm_request);
    if (http > 0 && req > 0 && http < req) {
      log.warn(
        { http_client: t.http_client, llm_request: t.llm_request },
        "http_client < llm_request — HTTP may abort before the watchdog reacts",
      );
    }
  }
}
