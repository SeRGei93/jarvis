import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "../../src/db/schema.js";
import { runMigrations } from "../../src/db/migrate.js";

export interface TestDb {
  db: LibSQLDatabase<typeof schema>;
  client: Client;
  url: string;
  cleanup: () => void;
}

/**
 * Spin up an isolated libSQL database (unique temp FILE) with all migrations
 * applied. Long-term memory is a plain relational table — no vector index.
 * Call `cleanup()` when done.
 */
export async function createTestDb(): Promise<TestDb> {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-test-"));
  const url = `file:${join(dir, "test.db")}`;
  const client = createClient({ url });
  const db = drizzle(client, { schema });
  await runMigrations(db);
  return {
    db,
    client,
    url,
    cleanup: () => {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
