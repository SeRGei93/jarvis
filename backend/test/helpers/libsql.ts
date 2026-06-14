import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { LibSQLVector } from "@mastra/libsql";
import * as schema from "../../src/db/schema.js";
import { runMigrations } from "../../src/db/migrate.js";
import { ensureMemoriesIndex } from "../../src/db/vector.js";

export interface TestDb {
  db: LibSQLDatabase<typeof schema>;
  client: Client;
  vector: LibSQLVector;
  url: string;
  cleanup: () => void;
}

/**
 * Spin up an isolated libSQL database (unique temp FILE so the drizzle client and
 * the LibSQLVector — separate connections — share the same data) with all
 * migrations and the memories vector index applied. Call `cleanup()` when done.
 */
export async function createTestDb(): Promise<TestDb> {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-test-"));
  const url = `file:${join(dir, "test.db")}`;
  const client = createClient({ url });
  const db = drizzle(client, { schema });
  await runMigrations(db);
  const vector = new LibSQLVector({ url, id: "test-memories" });
  await ensureMemoriesIndex(vector);
  return {
    db,
    client,
    vector,
    url,
    cleanup: () => {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
