import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/libsql/migrator";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "migrate" });

/** Absolute path to the generated drizzle migrations folder. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

/** Apply all pending migrations. Safe to call on every startup. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runMigrations(db: LibSQLDatabase<any>): Promise<void> {
  log.info({ folder: MIGRATIONS_FOLDER }, "applying migrations");
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  log.info("migrations applied");
}
