import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "turso",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    url: process.env.LIBSQL_URL ?? "file:./data/avocado.db",
    authToken: process.env.LIBSQL_AUTH_TOKEN,
  },
});
