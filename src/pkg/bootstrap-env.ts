// Side-effect module: load `.env` into process.env exactly once, before anything
// reads it (logger reads LOG_LEVEL, env.ts reads secrets). Uses Node's built-in
// env-file loader (Node >= 22) — no `dotenv` dependency needed.
//
// Import this FIRST from any module that reads process.env at load time.
try {
  process.loadEnvFile();
} catch {
  // No `.env` file present (production with real env vars, or CI/tests) — fine.
}
