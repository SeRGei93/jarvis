import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Keep logger quiet during tests (pino accepts the "silent" level).
    // SERPER_API_KEY: the web-search client refuses to run without a key; tests
    // that assert the missing-key path inject an explicit empty `apiKey`.
    env: { LOG_LEVEL: "silent", SERPER_API_KEY: "test-serper-key" },
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
