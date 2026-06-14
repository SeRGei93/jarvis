import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema.js";
import { env } from "../config/env.js";
import { logger } from "../pkg/logger.js";

const log = logger.child({ mod: "db" });

/** Raw libSQL client (file locally, Turso in prod via LIBSQL_URL/LIBSQL_AUTH_TOKEN). */
export const libsql: Client = createClient({
  url: env.LIBSQL_URL,
  authToken: env.LIBSQL_AUTH_TOKEN,
});

/** Drizzle ORM handle over libSQL, typed with the full schema. */
export const db = drizzle(libsql, { schema });

const mode = env.LIBSQL_URL.startsWith("file:") ? "file" : "turso";
log.info({ mode }, "libSQL connected");
