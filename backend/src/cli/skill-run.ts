// CLI analog of the Mini App skill test-run (POST /admin/api/skills/:name/test).
//
// Loads the .env file BEFORE importing any module that reads process.env at load
// time (db/client → env.ts), then defers to the impl via a dynamic import. In a
// container, env vars come from the real process environment and the file load is
// a no-op; existing env vars are never overwritten by the file (--env-file semantics).
import { existsSync } from "node:fs";

for (const p of [".env", "../.env", "../../.env"]) {
  try {
    if (existsSync(p)) {
      process.loadEnvFile(p);
      break;
    }
  } catch {
    /* env may come from the real process environment (container) */
  }
}

const { runCli } = await import("./skill-run-impl.js");
await runCli();
