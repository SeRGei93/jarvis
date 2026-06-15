import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema.js";
import { settings, models as modelsTable, subscriptionPlans } from "./schema.js";
import { SettingKey } from "../config/settings-keys.js";
import {
  SEED_AGENT,
  SEED_MODEL_ROLES,
  SEED_MODELS,
  SEED_PLANS,
  SEED_TELEGRAM_ALLOWED_USERS,
  SEED_TIMEOUTS,
} from "./seed-data.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "seed" });

// Skills and system prompts are no longer seeded into the DB — they live in the
// file-backed content store (src/content/), populated from repo defaults on boot.

export type Db = LibSQLDatabase<typeof schema>;

async function seedSettings(db: Db): Promise<void> {
  const rows: { key: string; value: unknown }[] = [
    { key: SettingKey.ModelRoles, value: { ...SEED_MODEL_ROLES } },
    { key: SettingKey.Timeouts, value: { ...SEED_TIMEOUTS } },
    { key: SettingKey.Agent, value: { ...SEED_AGENT } },
    { key: SettingKey.TelegramAllowedUsers, value: SEED_TELEGRAM_ALLOWED_USERS },
  ];
  for (const r of rows) {
    log.debug({ key: r.key }, "seeding setting");
    await db.insert(settings).values(r).onConflictDoNothing();
  }
  log.info({ count: rows.length }, "seeded settings");
}

async function seedModels(db: Db): Promise<void> {
  for (const ref of SEED_MODELS) {
    const provider = ref.split(":")[0] ?? "openrouter";
    await db.insert(modelsTable).values({ ref, provider, enabled: true }).onConflictDoNothing();
  }
  log.info({ count: SEED_MODELS.length }, "seeded models");
}

async function seedPlans(db: Db): Promise<void> {
  for (const p of SEED_PLANS) {
    await db.insert(subscriptionPlans).values(p).onConflictDoNothing();
  }
  log.info({ count: SEED_PLANS.length }, "seeded subscription plans");
}

/** Seed the DB on first run (no-op if already seeded). */
export async function runSeed(db: Db): Promise<void> {
  const already = await db.select({ key: settings.key }).from(settings).limit(1);
  if (already.length > 0) {
    log.info("skip seed (already seeded)");
    return;
  }
  await seedSettings(db);
  await seedModels(db);
  await seedPlans(db);
  log.info("seed complete");
}

// `npm run db:seed` entry point: migrate then seed the env-configured DB.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { db } = await import("./client.js");
  const { runMigrations } = await import("./migrate.js");
  await runMigrations(db);
  await runSeed(db);
  process.exit(0);
}
