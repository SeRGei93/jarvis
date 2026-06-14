import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { env } from "../config/env.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "db" });

/** Raw libSQL client (file locally, Turso in prod via LIBSQL_URL/LIBSQL_AUTH_TOKEN). */
export const libsql: Client = createClient({
  url: env.LIBSQL_URL,
  authToken: env.LIBSQL_AUTH_TOKEN,
});

/**
 * Drizzle ORM handle over libSQL. The schema is attached in a later task
 * (db/schema.ts) — for now this is a bare client used to verify connectivity.
 */
export const db = drizzle(libsql);

const mode = env.LIBSQL_URL.startsWith("file:") ? "file" : "turso";
log.info({ mode }, "libSQL connected");
